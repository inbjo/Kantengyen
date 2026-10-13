//! Paired whole-table trials across horizons, turn orders and public score positions.
use kantengyen_core::{
    Card, DECK_SIZE, Game,
    strategy::{MatchContext, Policy, choose_in_match},
};
use rand::{Rng, SeedableRng, rngs::StdRng, seq::SliceRandom};
use serde::Serialize;
use std::time::Instant;
#[derive(Default, Clone, Serialize)]
struct Metrics {
    tables: u64,
    games: u64,
    champion_share: f64,
    score_gain: i64,
    score_gain_squared: f64,
    losing_remaining: u64,
    losses: u64,
    closed: u64,
    decisions: u64,
    decision_ns: u128,
    max_decision_ns: u128,
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let arg = |key: &str, default: &str| {
        args.windows(2)
            .find(|a| a[0] == key)
            .map(|a| a[1].clone())
            .unwrap_or(default.into())
    };
    let repetitions: usize = arg("--repetitions", "100").parse().unwrap();
    let seed: u64 = arg("--seed", "2026101501").parse().unwrap();
    let output = arg("--output", "reports/match-screen.json");
    let long_repetitions: usize = arg("--long-repetitions", "20").parse().unwrap();
    let horizons = if args.iter().any(|a| a == "--extended") {
        vec![1usize, 8, 16, 32, 128, 0]
    } else {
        vec![8usize, 16, 32]
    };
    let weights = [0.0, 0.5, 1.5];
    let names = ["single_round_only", "match_mild", "match_strong"];
    let mut rng = StdRng::seed_from_u64(seed);
    let start = Instant::now();
    let mut total = vec![Metrics::default(); 3];
    let mut rows = vec![];
    let mut completed = 0;
    let mut paired_champion = [0.0; 3];
    let mut paired_champion_sq = [0.0; 3];
    let mut paired_score = [0.0; 3];
    let mut paired_score_sq = [0.0; 3];
    for n in 2..=8 {
        for &horizon in &horizons {
            let evaluation_rounds = if horizon == 0 { 128 } else { horizon };
            let cell_repetitions = if evaluation_rounds >= 128 {
                long_repetitions
            } else {
                repetitions
            };
            for winner_order in [false, true] {
                for position in [-1i64, 0, 1] {
                    let mut cell = vec![Metrics::default(); 3];
                    for trial in 0..cell_repetitions {
                        let seat = trial % n;
                        let mut initial = vec![0i64; n];
                        initial[seat] = position * 24;
                        initial[(seat + 1) % n] = -position * 24;
                        let schedules: Vec<_> = (0..evaluation_rounds)
                            .map(|_| {
                                let mut deck: Vec<Card> = (0..DECK_SIZE).collect();
                                deck.shuffle(&mut rng);
                                (deck, rng.random_range(0..n))
                            })
                            .collect();
                        let mut shares = [0.0; 3];
                        let mut gains = [0i64; 3];
                        for (mode, &weight) in weights.iter().enumerate() {
                            let mut scores = initial.clone();
                            let mut last_winner = None;
                            for (round, (deck, random_dealer)) in schedules.iter().enumerate() {
                                let dealer = if winner_order {
                                    last_winner.unwrap_or(*random_dealer)
                                } else {
                                    *random_dealer
                                };
                                let mut game = Game::deal(deck.clone(), n, dealer);
                                let mut turns = 0;
                                while game.winner.is_none() && turns < 2000 {
                                    let actor = game.turn;
                                    let ctx = MatchContext {
                                        own_score: scores[actor],
                                        best_other_score: *scores
                                            .iter()
                                            .enumerate()
                                            .filter(|(s, _)| *s != actor)
                                            .map(|(_, v)| v)
                                            .max()
                                            .unwrap(),
                                        rounds_remaining: if horizon == 0 {
                                            None
                                        } else {
                                            Some((horizon - round) as u32)
                                        },
                                    };
                                    let began = Instant::now();
                                    // Every simulated player sees only their own cards and public information.
                                    let action = choose_in_match(
                                        &kantengyen_core::strategy::Observation::from_game(&game),
                                        Policy::Adaptive,
                                        Some(ctx),
                                        if actor == seat { weight } else { 0.5 },
                                    );
                                    let elapsed = began.elapsed().as_nanos();
                                    if actor == seat {
                                        cell[mode].decisions += 1;
                                        cell[mode].decision_ns += elapsed;
                                        cell[mode].max_decision_ns =
                                            cell[mode].max_decision_ns.max(elapsed);
                                    }
                                    if let Some(cards) = action {
                                        game.play(actor, cards).unwrap();
                                    } else {
                                        game.pass(actor).unwrap();
                                    }
                                    turns += 1;
                                }
                                assert!(game.winner.is_some());
                                assert_eq!(game.result.iter().sum::<i64>(), 0);
                                let mut cards: Vec<_> = game
                                    .hands
                                    .iter()
                                    .flatten()
                                    .chain(game.deck.iter())
                                    .chain(game.discarded.iter())
                                    .copied()
                                    .collect();
                                cards.sort_unstable();
                                assert_eq!(cards, (0..54).collect::<Vec<_>>());
                                for (score, delta) in scores.iter_mut().zip(&game.result) {
                                    *score += delta;
                                }
                                last_winner = game.winner.filter(|&s| s < n);
                                cell[mode].games += 1;
                                if game.winner.is_some_and(|s| s != seat && s < n) {
                                    cell[mode].losses += 1;
                                    cell[mode].losing_remaining += game.hands[seat].len() as u64;
                                    cell[mode].closed += u64::from(game.played[seat] == 0);
                                }
                            }
                            assert_eq!(scores.iter().sum::<i64>(), 0);
                            let best = *scores.iter().max().unwrap();
                            let ties = scores.iter().filter(|&&s| s == best).count();
                            shares[mode] = if scores[seat] == best {
                                1.0 / ties as f64
                            } else {
                                0.0
                            };
                            gains[mode] = scores[seat] - initial[seat];
                            cell[mode].tables += 1;
                            cell[mode].champion_share += shares[mode];
                            cell[mode].score_gain += gains[mode];
                            cell[mode].score_gain_squared += (gains[mode] as f64).powi(2);
                        }
                        for i in 0..3 {
                            let d = shares[i] - shares[0];
                            paired_champion[i] += d;
                            paired_champion_sq[i] += d * d;
                            let d = (gains[i] - gains[0]) as f64;
                            paired_score[i] += d;
                            paired_score_sq[i] += d * d;
                        }
                        completed += 1;
                    }
                    for i in 0..3 {
                        total[i].tables += cell[i].tables;
                        total[i].games += cell[i].games;
                        total[i].champion_share += cell[i].champion_share;
                        total[i].score_gain += cell[i].score_gain;
                        total[i].score_gain_squared += cell[i].score_gain_squared;
                        total[i].losing_remaining += cell[i].losing_remaining;
                        total[i].losses += cell[i].losses;
                        total[i].closed += cell[i].closed;
                        total[i].decisions += cell[i].decisions;
                        total[i].decision_ns += cell[i].decision_ns;
                        total[i].max_decision_ns =
                            total[i].max_decision_ns.max(cell[i].max_decision_ns);
                    }
                    rows.push(serde_json::json!({"players":n,"rounds":horizon,"evaluation_rounds":evaluation_rounds,"winner_order":winner_order,"starting_position":position,"metrics":cell}));
                }
            }
            eprintln!(
                "n={n} horizon={horizon}: {completed} paired tables in {:.1}s",
                start.elapsed().as_secs_f64()
            );
        }
    }
    let summaries:Vec<_>=total.iter().enumerate().map(|(i,m)|{let n=m.tables as f64;let d=paired_champion[i]/n;let ds=paired_score[i]/n;serde_json::json!({"name":names[i],"risk_weight":weights[i],"metrics":m,"champion_rate":m.champion_share/n,"mean_score_gain":m.score_gain as f64/n,"paired_champion_difference":d,"paired_champion_standard_error":((paired_champion_sq[i]/n-d*d)/(n-1.0)).max(0.0).sqrt(),"paired_score_difference":ds,"paired_score_standard_error":((paired_score_sq[i]/n-ds*ds)/(n-1.0)).max(0.0).sqrt()})}).collect();
    let report = serde_json::json!({"seed":seed,"repetitions_per_cell":repetitions,"long_repetitions_per_cell":long_repetitions,"horizons":horizons,"paired_tables":completed,"completed_games":total.iter().map(|m|m.games).sum::<u64>(),"elapsed_seconds":start.elapsed().as_secs_f64(),"names":names,"opponents":"adaptive with mild public-scoreboard risk adjustment","starting_positions":"own +24 / 0 / -24 with opposite score on next seat; total zero; tied champions share one win","summaries":summaries,"cells":rows});
    std::fs::write(output, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    for s in summaries {
        println!(
            "{} champion={:.3}% score/table={:.3} paired champion={:.3}% ±{:.3}% paired score={:.3} ±{:.3}",
            s["name"].as_str().unwrap(),
            s["champion_rate"].as_f64().unwrap() * 100.0,
            s["mean_score_gain"].as_f64().unwrap(),
            s["paired_champion_difference"].as_f64().unwrap() * 100.0,
            s["paired_champion_standard_error"].as_f64().unwrap() * 196.0,
            s["paired_score_difference"].as_f64().unwrap(),
            s["paired_score_standard_error"].as_f64().unwrap() * 1.96
        );
    }
}
