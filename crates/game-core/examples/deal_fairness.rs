//! Runs the production dealer implementation with a reproducible test RNG.
#[allow(dead_code)]
#[path = "../../server/src/dealing.rs"]
mod dealing;
use rand::{SeedableRng, rngs::StdRng};
use serde_json::json;
fn main() {
    let mut rng = StdRng::seed_from_u64(2026101307);
    let mut rows = vec![];
    let rounds = 50000usize;
    for n in 2..=8 {
        let mut card_counts = vec![vec![0usize; 54]; n];
        let mut dealers = vec![0usize; n];
        let mut roles = vec![vec![0usize; 54]; 2];
        let mut role_deals = [0usize; 2];
        let mut bombs = vec![0usize; n];
        let mut jokers = vec![0usize; n];
        for _ in 0..rounds {
            let g = dealing::deal_with_rng(n, None, &mut rng);
            dealers[g.dealer] += 1;
            for (s, h) in g.hands.iter().enumerate() {
                let role = usize::from(s == g.dealer);
                role_deals[role] += 1;
                let mut ranks = [0usize; 16];
                for &c in h {
                    card_counts[s][c as usize] += 1;
                    roles[role][c as usize] += 1;
                    if c >= 52 {
                        jokers[s] += 1;
                    } else {
                        ranks[kantengyen_core::rank(c) as usize] += 1;
                    }
                }
                if ranks.iter().any(|&count| count >= 3) {
                    bombs[s] += 1;
                }
            }
        }
        let mut max_card_z = 0.0f64;
        let mut max_dealer_z = 0.0f64;
        for s in 0..n {
            let p = (5.0 + 1.0 / n as f64) / 54.0;
            let mean = rounds as f64 * p;
            let sd = (rounds as f64 * p * (1.0 - p)).sqrt();
            for &count in &card_counts[s] {
                max_card_z = max_card_z.max((count as f64 - mean).abs() / sd);
            }
            let p = 1.0 / n as f64;
            max_dealer_z = max_dealer_z.max(
                (dealers[s] as f64 - rounds as f64 * p).abs()
                    / (rounds as f64 * p * (1.0 - p)).sqrt(),
            );
        }
        let mut max_role_z = 0.0f64;
        for role in 0..2 {
            let p = (5 + role) as f64 / 54.0;
            let mean = role_deals[role] as f64 * p;
            let sd = (role_deals[role] as f64 * p * (1.0 - p)).sqrt();
            for &count in &roles[role] {
                max_role_z = max_role_z.max((count as f64 - mean).abs() / sd);
            }
        }
        assert!(
            max_card_z < 6.5 && max_dealer_z < 6.5 && max_role_z < 6.5,
            "unexpected shuffle bias"
        );
        rows.push(json!({"players":n,"deals":rounds,"dealer_counts":dealers,"jokers_by_seat":jokers,"natural_bombs_by_seat":bombs,"card_counts_by_seat":card_counts,"card_counts_by_role_non_dealer_then_dealer":roles,"role_deals":role_deals,"max_card_z":max_card_z,"max_dealer_z":max_dealer_z,"max_role_z":max_role_z}));
    }
    let report = json!({"seed":2026101307u64,"deals":rounds*7,"threshold_z":6.5,"note":"Random dealer mode; every card's inclusion rate tested by seat and separately by dealer role. Statistical check is evidence against bias, not proof of exact randomness.","rows":rows});
    std::fs::write(
        "reports/deal-fairness.json",
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "{} production-path deals passed seat/card/role distribution checks",
        rounds * 7
    );
}
