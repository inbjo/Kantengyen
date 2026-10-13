//! Reproducible paired-deal evaluation. Strategies receive Observation, never Game.
use kantengyen_core::{
    Card, DECK_SIZE, Game,
    strategy::{Observation, Policy, choose},
};
use rand::{Rng, SeedableRng, rngs::StdRng, seq::SliceRandom};
use serde::Serialize;
use std::{collections::HashSet, time::Instant};
#[derive(Default, Serialize, Clone)]
struct Metrics {
    games: u64,
    wins: u64,
    draws: u64,
    score: i64,
    score_squared: f64,
    losing_remaining: u64,
    losses: u64,
    closed: u64,
    decisions: u64,
    decision_ns: u128,
    max_decision_ns: u128,
    turns: u64,
}
impl Metrics {
    fn record(&mut self, g: &Game, seat: usize, turns: u64) {
        self.games += 1;
        self.turns += turns;
        self.score += g.result[seat];
        self.score_squared += (g.result[seat] as f64).powi(2);
        if g.winner == Some(seat) {
            self.wins += 1;
        } else if g.winner == Some(usize::MAX) {
            self.draws += 1;
        } else {
            self.losses += 1;
            self.losing_remaining += g.hands[seat].len() as u64;
            self.closed += u64::from(g.played[seat] == 0);
        }
    }
}
#[derive(Serialize)]
struct Row {
    policy: String,
    metrics: Metrics,
    per_players: Vec<Metrics>,
    per_opponent: Vec<Metrics>,
    mean_score: f64,
    score_standard_error: f64,
    win_rate: f64,
    paired_score_difference: f64,
    paired_difference_standard_error: f64,
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let arg = |key: &str, default: &str| {
        args.windows(2)
            .find(|a| a[0] == key)
            .map(|a| a[1].clone())
            .unwrap_or(default.into())
    };
    let games: usize = arg("--games", "25000").parse().unwrap();
    let seed: u64 = arg("--seed", "20261013").parse().unwrap();
    let output = arg("--output", "reports/strategy-screen.json");
    let start = Instant::now();
    let mut rng = StdRng::seed_from_u64(seed);
    let mut metrics = vec![Metrics::default(); 5];
    let mut per_players = vec![vec![Metrics::default(); 7]; 5];
    let mut per_opponent = vec![vec![Metrics::default(); 5]; 5];
    let mut pair_sum = [[0.0; 5]; 5];
    let mut pair_sq = [[0.0; 5]; 5];
    let mut differences = [0.0; 5];
    let mut differences_squared = [0.0; 5];
    for index in 0..games {
        let n = 2 + index % 7;
        let dealer = rng.random_range(0..n);
        let seat = (index / 7) % n;
        let opponent = Policy::ALL[(index / 49) % 5];
        let mut deck: Vec<Card> = (0..DECK_SIZE).collect();
        deck.shuffle(&mut rng);
        let mut scores = [0i64; 5];
        let mut baseline = 0;
        for (pi, policy) in Policy::ALL.iter().enumerate() {
            let mut g = Game::deal(deck.clone(), n, dealer);
            let mut turns = 0;
            while g.winner.is_none() && turns < 2000 {
                let actor = g.turn;
                let observation = Observation::from_game(&g);
                let began = Instant::now();
                let action = choose(&observation, if actor == seat { *policy } else { opponent });
                let elapsed = began.elapsed().as_nanos();
                if actor == seat {
                    metrics[pi].decisions += 1;
                    metrics[pi].decision_ns += elapsed;
                    metrics[pi].max_decision_ns = metrics[pi].max_decision_ns.max(elapsed);
                }
                if let Some(cards) = action {
                    g.play(actor, cards).unwrap();
                } else if g.last.is_some() {
                    g.pass(actor).unwrap();
                } else {
                    panic!("no legal lead seed {seed} deal {index}");
                }
                turns += 1;
            }
            assert!(g.winner.is_some(), "stalled deal {index}");
            assert_eq!(g.result.iter().sum::<i64>(), 0);
            let all: Vec<_> = g
                .hands
                .iter()
                .flatten()
                .chain(g.deck.iter())
                .chain(g.discarded.iter())
                .copied()
                .collect();
            assert_eq!(all.len(), 54);
            assert_eq!(all.iter().collect::<HashSet<_>>().len(), 54);
            metrics[pi].record(&g, seat, turns);
            per_players[pi][n - 2].record(&g, seat, turns);
            per_opponent[pi][(index / 49) % 5].record(&g, seat, turns);
            scores[pi] = g.result[seat];
            if pi == 0 {
                baseline = g.result[seat];
            }
            let d = (g.result[seat] - baseline) as f64;
            differences[pi] += d;
            differences_squared[pi] += d * d;
        }
        for i in 0..5 {
            for j in 0..5 {
                let d = (scores[i] - scores[j]) as f64;
                pair_sum[i][j] += d;
                pair_sq[i][j] += d * d;
            }
        }
        if (index + 1) % 5000 == 0 {
            eprintln!(
                "{} completed games in {:.1}s",
                (index + 1) * 5,
                start.elapsed().as_secs_f64()
            );
        }
    }
    let rows: Vec<_> = Policy::ALL
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let m = &metrics[i];
            let n = m.games as f64;
            let mean = m.score as f64 / n;
            Row {
                policy: p.name().into(),
                metrics: m.clone(),
                per_players: per_players[i].clone(),
                per_opponent: per_opponent[i].clone(),
                mean_score: mean,
                score_standard_error: ((m.score_squared / n - mean * mean) / (n - 1.0)).sqrt(),
                win_rate: m.wins as f64 / n,
                paired_score_difference: differences[i] / n,
                paired_difference_standard_error: ((differences_squared[i] / n
                    - (differences[i] / n).powi(2))
                    / (n - 1.0))
                    .sqrt(),
            }
        })
        .collect();
    let paired:Vec<_>=Policy::ALL.iter().enumerate().map(|(i,a)| Policy::ALL.iter().enumerate().map(|(j,b)| {let n=games as f64;let d=pair_sum[i][j]/n;serde_json::json!({"a":a.name(),"b":b.name(),"mean_difference":d,"standard_error":((pair_sq[i][j]/n-d*d)/(n-1.0)).max(0.0).sqrt()})}).collect::<Vec<_>>()).collect();
    let report = serde_json::json!({"seed":seed,"paired_deals":games,"completed_games":games*5,"opponents":"blocks of legacy/shape/control/score/adaptive; identical deck, focal seat, dealer and opponent policy for every candidate", "elapsed_seconds":start.elapsed().as_secs_f64(),"paired_comparisons":paired,"rows":rows});
    std::fs::write(&output, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    for r in rows {
        println!(
            "{} games={} score={:.4} ±{:.4} win={:.2}% paired={:.4} ±{:.4} loss_cards={:.3} closed={:.2}% mean_us={:.1} max_ms={:.2}",
            r.policy,
            r.metrics.games,
            r.mean_score,
            r.score_standard_error * 1.96,
            r.win_rate * 100.0,
            r.paired_score_difference,
            r.paired_difference_standard_error * 1.96,
            r.metrics.losing_remaining as f64 / r.metrics.losses as f64,
            r.metrics.closed as f64 / r.metrics.games as f64 * 100.0,
            r.metrics.decision_ns as f64 / r.metrics.decisions as f64 / 1000.0,
            r.metrics.max_decision_ns as f64 / 1e6
        );
    }
}
