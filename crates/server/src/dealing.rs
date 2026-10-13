//! Unbiased Fisher–Yates shuffle, without score/identity/hand-quality inputs.
use kantengyen_core::{Card, DECK_SIZE, Game};
use rand::{Rng, SeedableRng, rngs::StdRng, seq::SliceRandom};

pub fn random_game(players: usize, preferred_dealer: Option<usize>) -> Game {
    // A fresh OS-seeded cryptographic generator for every real round.
    deal_with_rng(players, preferred_dealer, &mut StdRng::from_os_rng())
}
pub fn deal_with_rng(players: usize, preferred_dealer: Option<usize>, rng: &mut impl Rng) -> Game {
    assert!((2..=8).contains(&players));
    let dealer = preferred_dealer.unwrap_or_else(|| rng.random_range(0..players));
    assert!(dealer < players);
    let mut deck: Vec<Card> = (0..DECK_SIZE).collect();
    deck.shuffle(rng);
    Game::deal(deck, players, dealer)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_deal_is_complete_and_only_dealer_gets_six() {
        let mut rng = StdRng::seed_from_u64(97);
        for n in 2..=8 {
            for preferred in [None, Some(n - 1)] {
                for _ in 0..100 {
                    let game = deal_with_rng(n, preferred, &mut rng);
                    if let Some(s) = preferred {
                        assert_eq!(game.dealer, s);
                    }
                    for (s, hand) in game.hands.iter().enumerate() {
                        assert_eq!(hand.len(), if s == game.dealer { 6 } else { 5 });
                    }
                    let mut all: Vec<_> = game
                        .hands
                        .iter()
                        .flatten()
                        .chain(game.deck.iter())
                        .copied()
                        .collect();
                    all.sort_unstable();
                    assert_eq!(all, (0..DECK_SIZE).collect::<Vec<_>>());
                }
            }
        }
    }
}
