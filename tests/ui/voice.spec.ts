import { test, expect, type Page } from "@playwright/test";

async function observe(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { voiceStreams: MediaStream[]; voicePeers: RTCPeerConnection[]; mediaRequests: number; mediaErrors: unknown[]; voiceIceErrors: unknown[] };
    state.voiceStreams = []; state.voicePeers = []; state.mediaRequests = 0; state.mediaErrors = []; state.voiceIceErrors = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.mediaRequests++;
      try {
        const stream = await getUserMedia(constraints);
        state.voiceStreams.push(stream);
        return stream;
      } catch (error) {
        state.mediaErrors.push({ name: (error as Error).name, message: (error as Error).message });
        throw error;
      }
    };
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        super(config); state.voicePeers.push(this);
        this.addEventListener("icecandidateerror", event => state.voiceIceErrors.push({ url: event.url, code: event.errorCode, error: event.errorText }));
      }
    };
  });
}
async function stopped(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window as typeof window & { voiceStreams: MediaStream[]; voicePeers: RTCPeerConnection[] };
    return state.voiceStreams.every(stream => stream.getTracks().every(track => track.readyState === "ended"))
      && state.voicePeers.every(peer => peer.signalingState === "closed") && !document.querySelector("audio[data-voice-peer]");
  })).toBe(true);
}
test("real three-way WebRTC audio, mute, rejoin and game-end cleanup", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 844, height: 390 } });
  const host = await context.newPage();
  const friend = await context.newPage();
  const third = await context.newPage();
  const pages = [host, friend, third];
  try {
    for (const page of pages) await observe(page);
    await host.goto("/");
    await host.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
    await host.getByRole("button", { name: /创建房间/ }).click();
    await host.getByRole("button", { name: "确认开桌" }).click();
    const code = await host.locator(".waiting-center h2 span").innerText();
    for (const page of [friend, third]) {
      await page.goto(`/?room=${code}`);
      await page.getByRole("button", { name: "加入房间", exact: true }).click();
    }
    for (const page of pages) {
      expect(await page.evaluate(() => (window as typeof window & { mediaRequests: number }).mediaRequests)).toBe(0);
      await page.getByRole("button", { name: "房间语音", exact: true }).click();
    }
    await Promise.all(pages.map(page => page.getByRole("button", { name: "开启房间语音" }).click()));
    for (const page of pages) {
      await expect(page.locator('.voice-members [data-state="connected"]')).toHaveCount(2, { timeout: 20_000 });
      await expect.poll(() => page.evaluate(async () => {
        const peers = (window as typeof window & { voicePeers: RTCPeerConnection[] }).voicePeers.filter(peer => peer.connectionState === "connected");
        const counts = await Promise.all(peers.map(async peer => {
          const stats = await peer.getStats();
          return [...stats.values()].some(report => report.type === "inbound-rtp" && report.kind === "audio" && report.packetsReceived > 0);
        }));
        return counts.length === 2 && counts.every(Boolean);
      }), { timeout: 20_000 }).toBe(true);
      if (process.env.EXPECT_TURN_RELAY === "1") {
        await expect.poll(() => page.evaluate(async () => {
          const peers = (window as typeof window & { voicePeers: RTCPeerConnection[] }).voicePeers.filter(peer => peer.connectionState === "connected");
          return peers.length === 2 && (await Promise.all(peers.map(async peer => {
            const stats = await peer.getStats();
            const transport = [...stats.values()].find(report => report.type === "transport" && report.selectedCandidatePairId);
            const pair = transport && stats.get(transport.selectedCandidatePairId);
            return pair && stats.get(pair.localCandidateId)?.candidateType === "relay"
              && stats.get(pair.remoteCandidateId)?.candidateType === "relay";
          }))).every(Boolean);
        }), { timeout: 20_000 }).toBe(true);
        if (process.env.EXPECT_TURN_TRANSPORT) {
          const transports = await page.evaluate(async () => {
            const peers = (window as typeof window & { voicePeers: RTCPeerConnection[] }).voicePeers.filter(peer => peer.connectionState === "connected");
            return Promise.all(peers.map(async peer => {
              const stats = await peer.getStats();
              const transport = [...stats.values()].find(report => report.type === "transport" && report.selectedCandidatePairId);
              const pair = transport && stats.get(transport.selectedCandidatePairId);
              return pair && stats.get(pair.localCandidateId)?.relayProtocol;
            }));
          });
          expect(transports).toEqual([process.env.EXPECT_TURN_TRANSPORT, process.env.EXPECT_TURN_TRANSPORT]);
        }
      }
    }
    for (const [width, height] of [[390, 844], [667, 375], [1024, 768], [844, 390]]) {
      await host.setViewportSize({ width, height });
      expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const control = await host.getByRole("button", { name: "麦克风静音", exact: true }).boundingBox();
      expect(control!.x).toBeGreaterThanOrEqual(0);
      expect(control!.x + control!.width).toBeLessThanOrEqual(width);
      expect(control!.y + control!.height).toBeLessThanOrEqual(height);
    }
    await host.screenshot({ path: "test-results/voice-phone.png" });
    await host.getByRole("button", { name: "麦克风静音", exact: true }).click();
    expect(await host.evaluate(() => (window as typeof window & { voiceStreams: MediaStream[] }).voiceStreams[0].getAudioTracks().every(track => !track.enabled))).toBe(true);
    await expect(friend.locator(".voice-members").getByText("已静音", { exact: true })).toHaveCount(1);
    await host.getByRole("button", { name: "取消麦克风静音", exact: true }).click();
    await host.getByRole("button", { name: "扬声器静音", exact: true }).click();
    expect(await host.evaluate(() => [...document.querySelectorAll<HTMLAudioElement>("audio[data-voice-peer]")].every(audio => audio.muted))).toBe(true);
    await host.getByRole("button", { name: "取消扬声器静音", exact: true }).click();
    await friend.reload();
    await expect(host.locator(".voice-members > div")).toHaveCount(1);
    expect(await friend.evaluate(() => (window as typeof window & { mediaRequests: number }).mediaRequests)).toBe(0);
    await friend.getByRole("button", { name: "房间语音", exact: true }).click();
    await friend.getByRole("button", { name: "开启房间语音" }).click();
    await expect(host.locator('.voice-members [data-state="connected"]')).toHaveCount(2, { timeout: 20_000 });
    await third.getByRole("button", { name: "退出语音", exact: true }).click();
    await stopped(third);
    await expect(host.locator(".voice-members > div")).toHaveCount(1);
    await third.getByRole("button", { name: "开启房间语音" }).click();
    await expect(host.locator('.voice-members [data-state="connected"]')).toHaveCount(2, { timeout: 20_000 });
    await friend.getByRole("button", { name: "我准备好了" }).click();
    await expect(friend.getByRole("button", { name: "取消准备" })).toBeVisible();
    // Wait for the other browser to receive the new room version before acting.
    await expect(third.locator(".opponent-info small").filter({ hasText: "已准备" })).toHaveCount(1);
    await third.getByRole("button", { name: "我准备好了" }).click();
    await expect(third.getByRole("button", { name: "取消准备" })).toBeVisible();
    await host.getByRole("button", { name: "开始游戏" }).click();
    await expect(host.locator(".hand-cards .playing-card")).toHaveCount(6);
    await expect(host.locator('.voice-members [data-state="connected"]')).toHaveCount(2);
    await host.getByRole("button", { name: "结束游戏", exact: true }).click();
    await host.getByRole("button", { name: "确认结束游戏" }).click();
    for (const page of pages) {
      await expect(page.getByRole("heading", { name: "总计分" })).toBeVisible();
      await stopped(page);
    }
    await friend.reload();
    await expect(friend.getByRole("dialog")).toHaveCount(0);
    await expect(friend).toHaveURL(/\/$/);
    expect(await friend.evaluate(() => (window as typeof window & { mediaRequests: number }).mediaRequests)).toBe(0);
  } catch (error) {
    for (let i = 0; i < pages.length; i++) {
      const diagnostic = JSON.stringify(await pages[i].evaluate(async () => {
        const state = window as typeof window & { voicePeers: RTCPeerConnection[]; voiceIceErrors: unknown[]; mediaRequests: number; mediaErrors: unknown[] };
        return { mediaRequests: state.mediaRequests, mediaErrors: state.mediaErrors,
          status: document.querySelector('[role="status"]')?.textContent,
          peers: await Promise.all(state.voicePeers.map(async pc => {
          const stats = await pc.getStats();
          return { iceErrors: state.voiceIceErrors, gathering: pc.iceGatheringState,
            config: { policy: pc.getConfiguration().iceTransportPolicy, urls: pc.getConfiguration().iceServers?.map(server => server.urls) },
            state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, local: pc.localDescription?.type, remote: pc.remoteDescription?.type,
            transceivers: pc.getTransceivers().map(t => ({ direction: t.direction, current: t.currentDirection, sender: t.sender.track?.readyState, receiver: t.receiver.track?.readyState })),
            localMedia: pc.localDescription?.sdp.split("\r\n").filter(line => line.startsWith("m=") || /a=(sendrecv|sendonly|recvonly|inactive)/.test(line)),
            remoteMedia: pc.remoteDescription?.sdp.split("\r\n").filter(line => line.startsWith("m=") || /a=(sendrecv|sendonly|recvonly|inactive)/.test(line)),
            candidates: [...stats.values()].filter(item => item.type === "local-candidate" || item.type === "remote-candidate").map(item => ({ type: item.type, candidateType: item.candidateType })),
            pairs: [...stats.values()].filter(item => item.type === "candidate-pair").map(item => ({ state: item.state, nominated: item.nominated })) };
        })) };
      }));
      console.log("voice diagnostic", i, diagnostic);
      if (process.env.CI) {
        const message = diagnostic.slice(0, 3000).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
        console.log(`::error title=Browser voice diagnostic ${i}::${message}`);
      }
    }
    throw error;
  } finally { await context.close(); }
});

test("denied microphone permission leaves no active voice resources", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("denied", "NotAllowedError"); };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /创建房间/ }).click();
  await page.getByRole("button", { name: "确认开桌" }).click();
  await page.getByRole("button", { name: "房间语音", exact: true }).click();
  await page.getByRole("button", { name: "开启房间语音" }).click();
  await expect(page.getByRole("status")).toContainText("未获得麦克风权限");
  await expect(page.getByRole("button", { name: "开启房间语音" })).toBeEnabled();
  expect(await page.locator("audio[data-voice-peer]").count()).toBe(0);
});

test("canceling pending microphone permission stops a stream granted afterwards", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const state = window as typeof window & { pendingStream?: MediaStream; grantLater?: () => void };
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        state.pendingStream = stream;
        return new Promise<MediaStream>(resolve => { state.grantLater = () => resolve(stream); });
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
    await page.getByRole("button", { name: /创建房间/ }).click();
    await page.getByRole("button", { name: "确认开桌" }).click();
    await page.getByRole("button", { name: "房间语音", exact: true }).click();
    await page.getByRole("button", { name: "开启房间语音" }).click();
    await expect.poll(() => page.evaluate(() => !!(window as typeof window & { grantLater?: () => void }).grantLater)).toBe(true);
    await page.getByRole("button", { name: "取消开启语音" }).click();
    await page.evaluate(() => (window as typeof window & { grantLater: () => void }).grantLater());
    await expect.poll(() => page.evaluate(() => (window as typeof window & { pendingStream: MediaStream }).pendingStream.getTracks().every(track => track.readyState === "ended"))).toBe(true);
    await expect(page.getByRole("button", { name: "开启房间语音" })).toBeEnabled();
  } finally { await context.close(); }
});
