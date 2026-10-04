//! Deterministic rules shared by the native server and the browser WASM module.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub type Card = u8;
pub const DECK_SIZE: Card = 54;
pub fn rank(card: Card) -> u8 {
    if card < 52 { card % 13 + 3 } else { 0 }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Single,
    Pair,
    Straight,
    Bomb,
    DeepBomb,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pattern {
    pub kind: Kind,
    pub rank: u8,
    pub len: usize,
}

impl Pattern {
    fn bomb_level(&self) -> u8 {
        match self.kind {
            Kind::Bomb => 1,
            Kind::DeepBomb => 2,
            _ => 0,
        }
    }
    pub fn beats(&self, previous: &Self) -> bool {
        let a = self.bomb_level();
        let b = previous.bomb_level();
        if a > 0 {
            return a > b || (a == b && self.rank > previous.rank);
        }
        if b > 0 || self.kind != previous.kind || self.len != previous.len {
            return false;
        }
        self.rank == previous.rank + 1
            || (self.rank == 15 && previous.rank < 15 && self.kind != Kind::Straight)
    }
}

pub fn patterns(cards: &[Card]) -> Vec<Pattern> {
    if cards.is_empty()
        || cards.iter().any(|&c| c >= DECK_SIZE)
        || cards.iter().collect::<HashSet<_>>().len() != cards.len()
    {
        return vec![];
    }
    let natural: Vec<_> = cards
        .iter()
        .copied()
        .filter(|&c| c < 52)
        .map(rank)
        .collect();
    if natural.is_empty() {
        return vec![];
    }
    let n = cards.len();
    let mut result = vec![];
    if n == 1 {
        return vec![Pattern {
            kind: Kind::Single,
            rank: natural[0],
            len: 1,
        }];
    }
    if natural.iter().all(|&r| r == natural[0]) {
        let kind = match n {
            2 => Some(Kind::Pair),
            3 => Some(Kind::Bomb),
            4 => Some(Kind::DeepBomb),
            _ => None,
        };
        if let Some(kind) = kind {
            result.push(Pattern {
                kind,
                rank: natural[0],
                len: n,
            });
        }
    }
    if (3..=12).contains(&n)
        && !natural.contains(&15)
        && natural.iter().collect::<HashSet<_>>().len() == natural.len()
    {
        for start in 3..=(15 - n as u8) {
            if natural.iter().all(|&r| r >= start && r < start + n as u8) {
                result.push(Pattern {
                    kind: Kind::Straight,
                    rank: start,
                    len: n,
                });
            }
        }
    }
    result
}

pub fn resolve(cards: &[Card], previous: Option<&Pattern>) -> Result<Pattern, String> {
    let candidates = patterns(cards);
    match previous {
        Some(p) => candidates
            .into_iter()
            .find(|c| c.beats(p))
            .ok_or_else(|| "只能用相同牌型大一级接牌，或使用炸弹；2 可接任意较小单张或对子".into()),
        None => candidates
            .into_iter()
            .next()
            .ok_or_else(|| "这组牌不构成合法牌型，万能牌不能单出，也不能单独组成牌型".into()),
    }
}

/// Compact ABI: 54 card identities represented as two bit masks; zero means invalid.
/// The browser uses this advisory check; the server always validates the original cards.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn check_play(low: u32, high: u32, kind: u32, previous_rank: u32, len: u32) -> u32 {
    if high >> 22 != 0 {
        return 0;
    }
    let cards: Vec<_> = (0..DECK_SIZE)
        .filter(|&c| {
            if c < 32 {
                low & (1 << c) != 0
            } else {
                high & (1 << (c - 32)) != 0
            }
        })
        .collect();
    let previous_kind = match kind {
        0 => None,
        1 => Some(Kind::Single),
        2 => Some(Kind::Pair),
        3 => Some(Kind::Straight),
        4 => Some(Kind::Bomb),
        5 => Some(Kind::DeepBomb),
        _ => return 0,
    };
    let previous = previous_kind.map(|kind| Pattern {
        kind,
        rank: previous_rank as u8,
        len: len as usize,
    });
    match resolve(&cards, previous.as_ref()) {
        Ok(p) => {
            let k = match p.kind {
                Kind::Single => 1,
                Kind::Pair => 2,
                Kind::Straight => 3,
                Kind::Bomb => 4,
                Kind::DeepBomb => 5,
            };
            k * 65536 + p.rank as u32 * 256 + p.len as u32
        }
        Err(_) => 0,
    }
}

/// Generate structural candidates instead of enumerating all subsets of a large hand.
pub fn legal_moves(hand: &[Card], previous: Option<&Pattern>) -> Vec<Vec<Card>> {
    let wild: Vec<_> = hand.iter().copied().filter(|&c| c >= 52).collect();
    let mut moves: Vec<Vec<Card>> = vec![];
    for r in 3..=15 {
        let group: Vec<_> = hand.iter().copied().filter(|&c| rank(c) == r).collect();
        if group.is_empty() {
            continue;
        }
        moves.push(vec![group[0]]);
        for len in 2..=4 {
            let count = group.len().min(len);
            if count + wild.len() >= len {
                let mut cards = group[..count].to_vec();
                cards.extend_from_slice(&wild[..len - count]);
                moves.push(cards);
            }
        }
    }
    for len in 3..=12 {
        for start in 3..=(15 - len as u8) {
            let mut cards = vec![];
            let mut used = 0;
            let mut valid = true;
            for r in start..start + len as u8 {
                if let Some(&card) = hand.iter().find(|&&c| rank(c) == r) {
                    cards.push(card);
                } else if used < wild.len() {
                    cards.push(wild[used]);
                    used += 1;
                } else {
                    valid = false;
                    break;
                }
            }
            if valid {
                moves.push(cards);
            }
        }
    }
    moves.retain(|cards| resolve(cards, previous).is_ok());
    moves.sort_by_key(|cards| {
        let p = resolve(cards, previous).unwrap();
        (p.bomb_level(), std::cmp::Reverse(cards.len()), p.rank)
    });
    moves
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastPlay {
    pub seat: usize,
    pub cards: Vec<Card>,
    pub pattern: Pattern,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Game {
    pub hands: Vec<Vec<Card>>,
    pub deck: Vec<Card>,
    pub discarded: Vec<Card>,
    pub dealer: usize,
    pub turn: usize,
    pub last: Option<LastPlay>,
    pub passes: usize,
    pub multiplier: i64,
    pub played: Vec<usize>,
    pub winner: Option<usize>,
    pub result: Vec<i64>,
    pub message: String,
}

impl Game {
    pub fn deal(mut deck: Vec<Card>, players: usize, dealer: usize) -> Self {
        assert!((2..=8).contains(&players) && dealer < players && deck.len() == DECK_SIZE as usize);
        let mut hands = vec![vec![]; players];
        for _ in 0..5 {
            for offset in 0..players {
                hands[(dealer + offset) % players].push(deck.pop().unwrap());
            }
        }
        hands[dealer].push(deck.pop().unwrap());
        for hand in &mut hands {
            hand.sort_by_key(|&c| (rank(c) == 0, rank(c), c));
        }
        Self {
            hands,
            deck,
            discarded: vec![],
            dealer,
            turn: dealer,
            last: None,
            passes: 0,
            multiplier: 1,
            played: vec![0; players],
            winner: None,
            result: vec![0; players],
            message: "庄家先出牌，率先出完手牌的人获胜".into(),
        }
    }

    pub fn play(&mut self, seat: usize, cards: Vec<Card>) -> Result<(), String> {
        self.check_turn(seat)?;
        if cards.iter().any(|c| !self.hands[seat].contains(c)) {
            return Err("只能出自己手里的牌".into());
        }
        let pattern = resolve(&cards, self.last.as_ref().map(|p| &p.pattern))?;
        match pattern.kind {
            Kind::Bomb => self.multiplier *= 2,
            Kind::DeepBomb => self.multiplier *= 4,
            _ => {}
        }
        self.hands[seat].retain(|c| !cards.contains(c));
        self.played[seat] += cards.len();
        self.discarded.extend(&cards);
        self.last = Some(LastPlay {
            seat,
            cards,
            pattern,
        });
        self.passes = 0;
        self.message = "出牌成功".into();
        if self.hands[seat].is_empty() {
            self.finish(seat);
        } else {
            self.turn = (seat + 1) % self.hands.len();
        }
        Ok(())
    }

    pub fn pass(&mut self, seat: usize) -> Result<(), String> {
        self.check_turn(seat)?;
        let last_seat = self.last.as_ref().ok_or("你是领出玩家，需要出牌")?.seat;
        self.passes += 1;
        if self.passes == self.hands.len() - 1 {
            self.turn = last_seat;
            if let Some(card) = self.deck.pop() {
                self.hands[last_seat].push(card);
                self.hands[last_seat].sort_by_key(|&c| (rank(c) == 0, rank(c), c));
                self.message = "其他人都过牌，领出玩家摸一张牌后重新出牌".into();
            } else {
                self.message = "牌堆已空，领出玩家直接重新出牌".into();
            }
            self.last = None;
            self.passes = 0;
            // House rule for the validation build: replenish wildcard-only leaders until
            // they have a natural card, avoiding an otherwise undefined deadlock.
            while self.hands[last_seat].iter().all(|&c| c >= 52) && !self.deck.is_empty() {
                self.hands[last_seat].push(self.deck.pop().unwrap());
            }
            // A last wildcard cannot be played alone, and an exhausted deck cannot replenish it.
            if self.hands[last_seat].iter().all(|&c| c >= 52) && self.deck.is_empty() {
                self.draw();
            }
        } else {
            self.turn = (seat + 1) % self.hands.len();
            self.message = "过牌".into();
        }
        Ok(())
    }

    fn check_turn(&self, seat: usize) -> Result<(), String> {
        if self.winner.is_some() {
            Err("本局已结束".into())
        } else if seat != self.turn {
            Err("还没有轮到你".into())
        } else {
            Ok(())
        }
    }

    pub fn draw(&mut self) {
        self.winner = Some(usize::MAX);
        self.message = "牌堆耗尽且领出玩家只剩万能牌，本局和局".into();
    }

    fn finish(&mut self, winner: usize) {
        self.winner = Some(winner);
        for seat in 0..self.hands.len() {
            if seat == winner {
                continue;
            }
            let loss = self.hands[seat].len() as i64 * self.multiplier;
            self.result[seat] = -loss;
            self.result[winner] += loss;
        }
        self.message = "本局结束，每张剩余牌计 1 分，乘以炸弹倍率，赢家获得其余玩家扣分之和".into();
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn inspect_play(cards_json: &str, previous_json: &str) -> String {
    let result = (|| -> Result<_, String> {
        let cards: Vec<Card> = serde_json::from_str(cards_json).map_err(|e| e.to_string())?;
        let previous: Option<Pattern> =
            serde_json::from_str(previous_json).map_err(|e| e.to_string())?;
        resolve(&cards, previous.as_ref())
    })();
    serde_json::to_string(&result).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wildcards_duplicates_and_sequences() {
        assert!(resolve(&[52], None).is_err());
        assert!(resolve(&[52, 53], None).is_err());
        assert!(resolve(&[0, 0], None).is_err());
        assert_eq!(resolve(&[0, 52], None).unwrap().kind, Kind::Pair);
        assert_eq!(resolve(&[0, 1, 52], None).unwrap().kind, Kind::Straight);
        assert!(resolve(&[10, 11, 12], None).is_err());
        assert!(resolve(&[54], None).is_err());
        assert!(resolve(&[0, 54], None).is_err());
        assert_eq!(resolve(&[0, 53], None).unwrap().kind, Kind::Pair);
    }
    #[test]
    fn exact_step_twos_and_bombs() {
        let p = resolve(&[0], None).unwrap();
        assert!(resolve(&[1], Some(&p)).is_ok());
        assert!(resolve(&[2], Some(&p)).is_err());
        assert!(resolve(&[12], Some(&p)).is_ok());
        let bomb = resolve(&[0, 13, 26], None).unwrap();
        assert!(resolve(&[12], Some(&bomb)).is_err());
        assert!(resolve(&[1, 14, 27], Some(&bomb)).is_ok());
        let p = resolve(&[0, 1, 2], None).unwrap();
        assert!(resolve(&[1, 2, 3], Some(&p)).is_ok());
        assert!(resolve(&[2, 3, 4], Some(&p)).is_err());
    }
    #[test]
    fn turn_pass_draw_and_conservation() {
        let mut g = Game::deal((0..DECK_SIZE).collect(), 3, 0);
        assert!(g.play(1, vec![g.hands[1][0]]).is_err());
        let card = g.hands[0].iter().copied().find(|&c| c < 52).unwrap();
        g.play(0, vec![card]).unwrap();
        assert!(g.play(1, vec![card]).is_err());
        let before = g.hands[0].len();
        g.pass(1).unwrap();
        g.pass(2).unwrap();
        assert_eq!(g.turn, 0);
        assert!(g.last.is_none());
        assert_eq!(g.hands[0].len(), before + 1);
        let mut all = g.deck.clone();
        all.extend(g.discarded);
        all.extend(g.hands.into_iter().flatten());
        assert_eq!(all.len(), DECK_SIZE as usize);
        assert_eq!(
            all.into_iter().collect::<HashSet<_>>().len(),
            DECK_SIZE as usize
        );
    }
    #[test]
    fn scoring_is_zero_sum() {
        let mut g = Game::deal((0..DECK_SIZE).collect(), 2, 0);
        g.hands[0] = vec![0];
        g.play(0, vec![0]).unwrap();
        assert_eq!(g.winner, Some(0));
        assert_eq!(g.result.iter().sum::<i64>(), 0);
        assert_eq!(g.result, vec![5, -5]);
    }
    #[test]
    fn losses_are_remaining_cards_times_bombs_without_extra_multipliers() {
        for (winning_cards, other_hands, expected, multiplier) in [
            (vec![0], vec![vec![1, 8]], vec![2, -2], 1),
            (vec![0, 1, 2, 3, 4, 5], vec![vec![7, 8]], vec![2, -2], 1),
            (vec![0, 13, 26], vec![vec![1, 8]], vec![4, -4], 2),
            (vec![0, 13, 26, 39], vec![vec![1, 8]], vec![8, -8], 4),
            (
                vec![0, 13, 26],
                vec![vec![1, 8], vec![2, 9, 10]],
                vec![10, -4, -6],
                2,
            ),
        ] {
            let mut game = Game::deal((0..DECK_SIZE).collect(), other_hands.len() + 1, 0);
            game.hands = [vec![winning_cards.clone()], other_hands].concat();
            game.play(0, winning_cards).unwrap();
            assert_eq!(game.multiplier, multiplier);
            assert_eq!(game.result, expected);
            assert_eq!(game.result.iter().sum::<i64>(), 0);
        }
    }
    #[test]
    fn simulated_games_preserve_cards_and_finish() {
        for seed in 1..=80 {
            let mut deck: Vec<Card> = (0..DECK_SIZE).collect();
            let mut rng = seed as u64;
            for i in (1..deck.len()).rev() {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
                deck.swap(i, (rng as usize) % (i + 1));
            }
            let mut g = Game::deal(deck, 2 + seed % 7, 0);
            for _ in 0..1000 {
                if g.winner.is_some() {
                    break;
                }
                let seat = g.turn;
                let moves = legal_moves(&g.hands[seat], g.last.as_ref().map(|p| &p.pattern));
                if let Some(cards) = moves.into_iter().next() {
                    g.play(seat, cards).unwrap();
                } else if g.last.is_some() {
                    g.pass(seat).unwrap();
                } else {
                    panic!("no legal move on an open trick");
                }
                let mut cards = g.deck.clone();
                cards.extend(&g.discarded);
                cards.extend(g.hands.iter().flatten());
                assert_eq!(cards.len(), DECK_SIZE as usize);
                assert_eq!(
                    cards.into_iter().collect::<HashSet<_>>().len(),
                    DECK_SIZE as usize
                );
            }
            assert!(g.winner.is_some(), "seed {seed} stalled");
            assert_eq!(g.result.iter().sum::<i64>(), 0);
        }
    }
}
