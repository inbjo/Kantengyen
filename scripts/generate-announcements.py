r"""Generate bundled card announcements with an installed yovoice engine.

Example (PowerShell):
  python scripts/generate-announcements.py --install-dir D:\yovoice --character 1111
Use --reference to clone a specific approved demo instead of a character preview.
Local models and the
desktop library are read only; temporary files stay in the ignored .tools folder.
"""
import argparse
from array import array
import base64
import hashlib
import json
import math
from pathlib import Path
import socket
import shutil
import subprocess
import time
import urllib.request
import wave


def normalize_wav(path):
    with wave.open(str(path), "rb") as audio:
        rate = audio.getframerate()
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
        samples = array("h", audio.readframes(audio.getnframes()))
    # Keep 40 ms around the first/last audible sample; scale to a common RMS
    # without clipping. Uncompressed PCM works in all supported browsers.
    audible = [i for i, sample in enumerate(samples) if abs(sample) > 185]
    if not audible:
        raise ValueError(f"Silent generation: {path}")
    padding = int(rate * .04)
    samples = samples[max(0, audible[0] - padding):audible[-1] + padding + 1]
    rms = math.sqrt(sum(float(s) ** 2 for s in samples) / len(samples))
    scale = min(32767 * 10 ** (-18 / 20) / rms,
                32767 * 10 ** (-2 / 20) / max(abs(s) for s in samples))
    samples = array("h", (round(s * scale) for s in samples))
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(samples.tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".yovoice")
    parser.add_argument("--character", default="1111")
    parser.add_argument("--reference", type=Path, help="Exact demo WAV to clone")
    parser.add_argument("--output-dir", type=Path, help="Optional separate review folder")
    parser.add_argument("--keys", nargs="+", help="Generate selected clip keys for review")
    args = parser.parse_args()
    if args.keys and not args.output_dir:
        parser.error("--keys requires a separate --output-dir for review")
    root = Path(__file__).resolve().parent.parent
    work = root / ".tools" / "yovoice"
    output = args.output_dir or root / "web" / "src" / "assets" / "announcements"
    output = output.resolve()
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    state = json.loads((args.data_dir / "state.json").read_text(encoding="utf-8"))
    character = next(c for c in state["characters"] if c["name"] == args.character)
    reference = (args.reference or args.data_dir / "outputs" / character["preview"]["fileName"]).resolve()
    model = args.data_dir / "models" / "index-tts2_5-f16.gguf"
    engine = args.install_dir / "engine" / "audiocpp_server.exe"
    ffmpeg = args.install_dir / "tools" / "ffmpeg.exe"
    for path in [reference, model, engine, ffmpeg]:
        if not path.is_file():
            raise FileNotFoundError(path)
    reference_sha = hashlib.sha256(reference.read_bytes()).hexdigest()
    cache = work / reference_sha[:16]
    cache.mkdir(exist_ok=True)
    manifest_path = output / "manifest.json"
    previous = {}
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        if previous["character"] != args.character:
            raise ValueError("Back up and move the existing announcements folder before changing character")
        if previous.get("reference_sha256") != reference_sha:
            backup = work / f"backup-{time.time_ns()}"
            shutil.copytree(output, backup)
            print(f"Backed up old recordings: {backup}", flush=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config = {"host": "127.0.0.1", "port": port, "backend": "cuda", "device": 0,
              "threads": 6, "lazy_load": True, "max_loaded_models": 1,
              "idle_unload_ms": 300000, "max_request_body_bytes": 1048576,
              "log_request_body": False,
              "models": [{"id": "index", "family": "index_tts2", "task": "tts",
                          "mode": "offline", "path": str(model)}]}
    config_path = work / "server.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = f"http://127.0.0.1:{port}"
    ranks = ["三", "四", "五", "六", "七", "八", "九", "十", "勾", "圈", "K", "尖", "二"]
    clips = [(f"single-{rank}", text) for rank, text in enumerate(ranks, 3)]
    clips += [(f"pair-{rank}", f"对{text}") for rank, text in enumerate(ranks, 3)]
    clips += [("small_joker", "小王"), ("big_joker", "大王"),
              ("straight", "顺子"), ("bomb", "炸弹"), ("deep_bomb", "四张炸弹"),
              ("pass", "过"), ("cannot_play", "要不起"), ("decline", "不要"),
              ("game_start", "游戏开始"), ("your_turn", "轮到你了"),
              ("one_left", "只剩一张牌"), ("round_end", "本局结束"),
              ("you_win", "你赢了"), ("again", "再来一局"),
              ("hurry", "快出牌吧"), ("time_warning", "时间快到了，请尽快出牌")]
    if args.keys:
        unknown = set(args.keys) - {key for key, _ in clips}
        if unknown:
            raise ValueError(f"Unknown clip keys: {sorted(unknown)}")
        clips = [(key, text) for key, text in clips if key in args.keys]
    with (work / "engine.log").open("wb") as log:
        process = subprocess.Popen([str(engine), "--config", str(config_path), "--no-ui"],
                                   cwd=engine.parent, stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            for _ in range(120):
                if process.poll() is not None:
                    raise RuntimeError(f"Engine exited: see {work / 'engine.log'}")
                try:
                    with opener.open(url + "/health", timeout=2):
                        break
                except OSError:
                    time.sleep(.25)
            else:
                raise TimeoutError("Engine startup timed out")
            for key, text in clips:
                target = output / f"{key}.wav"
                if (target.exists() and previous.get("reference_sha256") == reference_sha
                        and previous.get("clips", {}).get(key) == text):
                    print(f"Keeping {key}", flush=True)
                    continue
                print(f"Generating {key}: {text}", flush=True)
                payload = {"model": "index", "request": {
                    "text": text + "。", "voice_ref": str(reference),
                    "options": {"language": "zh", "seed": 1111,
                                "temperature": .7, "top_p": .8, "top_k": 30,
                                "repetition_penalty": 10, "max_tokens": 200,
                                "interval_silence_ms": 0, "do_sample": True,
                                "num_beams": 3, "length_penalty": 0}}}
                request = urllib.request.Request(url + "/v1/tasks/run",
                    data=json.dumps(payload, ensure_ascii=False).encode(),
                    headers={"Content-Type": "application/json"})
                text_hash = hashlib.sha256(text.encode()).hexdigest()[:8]
                wav = cache / f"{key}-{text_hash}.wav"
                if not wav.exists():
                    with opener.open(request, timeout=600) as response:
                        result = json.load(response)
                    wav.write_bytes(base64.b64decode(result["audio"], validate=True))
                temporary = cache / f"{key}-normalized.wav"
                subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(wav), "-ar", "24000", "-ac", "1", "-codec:a", "pcm_s16le",
                    str(temporary)], check=True)
                normalize_wav(temporary)
                target.write_bytes(temporary.read_bytes())
            manifest_path.write_text(json.dumps({
                "character": args.character, "model": "IndexTTS 2.5 F16", "seed": 1111,
                "reference": reference.name, "reference_sha256": reference_sha,
                "voice_description": "中文扑克游戏出牌播报，声音清自然晰、轻快有力，不夸张。各句使用一致的音色、语速和音量，不加背景音乐、混响或其他音效。",
                "clips": dict(clips),
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        finally:
            process.terminate()
            process.wait(timeout=30)


if __name__ == "__main__":
    main()
