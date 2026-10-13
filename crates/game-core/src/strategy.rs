//! Policies have no access to opponents' cards or the order of the stock.
use crate::{Card, DECK_SIZE, Game, Kind, LastPlay, Pattern, legal_moves, rank, resolve};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Legacy,
    Shape,
    Control,
    Score,
    Adaptive,
}
pub const AUTOMATED_POLICY: Policy = Policy::Adaptive;
pub const MATCH_RISK_WEIGHT: f64 = 1.5;

impl Policy {
    pub const ALL: [Self; 5] = [
        Self::Legacy,
        Self::Shape,
        Self::Control,
        Self::Score,
        Self::Adaptive,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Shape => "shape",
            Self::Control => "control",
            Self::Score => "score",
            Self::Adaptive => "adaptive",
        }
    }
}

/// Only public observations and the acting player's own hand cross this boundary.
pub struct Observation<'a> {
    pub hand: &'a [Card],
    pub discarded: &'a [Card],
    pub counts: Vec<usize>,
    pub played: &'a [usize],
    pub turn: usize,
    pub last: Option<&'a LastPlay>,
    pub stock_count: usize,
    pub multiplier: i64,
}
impl<'a> Observation<'a> {
    pub fn from_game(game: &'a Game) -> Self {
        Self {
            hand: &game.hands[game.turn],
            discarded: &game.discarded,
            counts: game.hands.iter().map(Vec::len).collect(),
            played: &game.played,
            turn: game.turn,
            last: game.last.as_ref(),
            stock_count: game.deck.len(),
            multiplier: game.multiplier,
        }
    }
}

/// Public scoreboard only. Remaining rounds includes the round in progress;
/// None means an unlimited table, whose objective stays long-run expected points.
#[derive(Clone, Copy, Debug)]
pub struct MatchContext {
    pub own_score: i64,
    pub best_other_score: i64,
    pub rounds_remaining: Option<u32>,
}

pub fn choose(obs: &Observation<'_>, policy: Policy) -> Option<Vec<Card>> {
    choose_in_match(obs, policy, None, 0.0)
}

pub fn choose_in_match(
    obs: &Observation<'_>,
    policy: Policy,
    context: Option<MatchContext>,
    risk_weight: f64,
) -> Option<Vec<Card>> {
    let previous = obs.last.map(|last| &last.pattern);
    let moves = legal_moves(obs.hand, previous);
    if moves.is_empty() {
        return None;
    }
    // If several winning plays exist, maximize the actual settlement multiplier.
    if let Some(cards) = moves
        .iter()
        .filter(|c| c.len() == obs.hand.len())
        .max_by_key(|c| bomb_factor(&resolve(c, previous).unwrap()))
    {
        return Some(cards.clone());
    }
    if policy == Policy::Legacy {
        return legacy(obs, moves);
    }
    let shape = Shape::new(obs.hand);
    let unknown = Unknown::new(obs);
    let urgency = obs
        .counts
        .iter()
        .enumerate()
        .filter(|(s, _)| *s != obs.turn)
        .map(|(_, &n)| {
            if n <= 2 {
                1.0
            } else if n == 3 {
                0.4
            } else {
                0.0
            }
        })
        .fold(0.0, f64::max);
    let mut best = None;
    let mut best_value = f64::NEG_INFINITY;
    for cards in moves {
        let p = resolve(&cards, previous).unwrap();
        let mask = shape.mask(&cards);
        let remaining = shape.full ^ mask;
        let groups = if obs.hand.len() <= 12 {
            shape.cost(remaining)
        } else {
            let left: Vec<_> = obs
                .hand
                .iter()
                .copied()
                .filter(|c| !cards.contains(c))
                .collect();
            let largest = legal_moves(&left, None)
                .iter()
                .map(Vec::len)
                .max()
                .unwrap_or(1);
            left.len().div_ceil(largest) as u8
        };
        let wild_left = obs
            .hand
            .iter()
            .filter(|&&c| c >= 52 && !cards.contains(&c))
            .count();
        let natural_left = obs.hand.len() - cards.len() - wild_left;
        let stranded = if natural_left == 0 && wild_left > 0 {
            8.0
        } else {
            0.0
        };
        let mut value = -(groups as f64) * 8.0 + cards.len() as f64 * 0.8 - stranded;
        if policy != Policy::Shape {
            value -= p.rank as f64
                * if matches!(p.kind, Kind::Single | Kind::Pair) {
                    if urgency > 0.0 { 0.05 } else { 0.15 }
                } else {
                    0.01
                };
            let replies: Vec<_> = obs
                .counts
                .iter()
                .enumerate()
                .filter(|(s, _)| *s != obs.turn)
                .map(|(s, &n)| (s, unknown.response(&p, n)))
                .collect();
            let control = replies.iter().map(|(_, r)| 1.0 - r).product::<f64>();
            // Exact +1 is what matters: a high single is not necessarily a safe single.
            let threat = replies
                .iter()
                .map(|(s, r)| if obs.counts[*s] <= p.len { *r } else { 0.0 })
                .sum::<f64>()
                .min(1.0);
            value += control * (0.2 + if groups <= 2 { 0.3 } else { 0.0 });
            value -= threat * (0.4 + 3.0 * urgency);
            // Holding a 2 or joker is useful only if it still fits a route out.
            value -= cards.iter().filter(|&&c| rank(c) == 15).count() as f64
                * if urgency > 0.0 { 0.05 } else { 0.2 };
            if obs.stock_count > 0 {
                value -= control * 0.1;
            }
            if matches!(policy, Policy::Score | Policy::Adaptive) {
                let factor = bomb_factor(&p) as f64;
                let opponents = obs.counts.len() - 1;
                let strong = (control * 0.6 + (1.0 / (groups as f64 + 0.5)) * 0.4).min(0.95);
                let liabilities = obs
                    .counts
                    .iter()
                    .enumerate()
                    .filter(|(s, _)| *s != obs.turn)
                    .map(|(s, &n)| if obs.played[s] == 0 { 10.0 } else { n as f64 })
                    .sum::<f64>();
                // Bombs increase everyone's exposure. Reward them with a short, controlled exit;
                // discourage speculative multipliers while far from winning.
                let win = strong.powf(opponents as f64 * 0.35 + groups as f64 * 0.55);
                let loss = (obs.hand.len() - cards.len()) as f64;
                value += (factor - 1.0) * (win * liabilities - (1.0 - win) * loss) * 0.15;
                if obs.played[obs.turn] == 0 {
                    value += 2.0;
                }
                value -= threat * (factor - 1.0) * 0.5;
            }
        }
        if policy == Policy::Adaptive && obs.counts.len() >= 5 {
            // A crowded table shortens the window to shed cards. Preserve the strong
            // partition prior; use visible-card safety to resolve nearby choices.
            let control = obs
                .counts
                .iter()
                .enumerate()
                .filter(|(s, _)| *s != obs.turn)
                .map(|(_, &n)| 1.0 - unknown.response(&p, n))
                .product::<f64>();
            let threat = obs
                .counts
                .iter()
                .enumerate()
                .filter(|(s, _)| *s != obs.turn)
                .map(|(_, &n)| {
                    if n == p.len {
                        unknown.response(&p, n)
                    } else {
                        0.0
                    }
                })
                .sum::<f64>()
                .min(1.0);
            value =
                -(groups as f64) * 8.0 + cards.len() as f64 * 0.8 - stranded - p.rank as f64 * 0.1
                    + control * 0.15
                    - threat;
        }
        if let Some(ctx) = context
            && let Some(rounds) = ctx.rounds_remaining.filter(|r| *r > 0)
        {
            let stakes = obs
                .counts
                .iter()
                .enumerate()
                .filter(|(s, _)| *s != obs.turn)
                .map(|(s, &n)| if obs.played[s] == 0 { 10.0 } else { n as f64 })
                .sum::<f64>()
                * obs.multiplier as f64;
            let pressure = ((ctx.best_other_score as f64 - ctx.own_score as f64) / stakes.max(1.0))
                .clamp(-1.0, 1.0)
                / rounds as f64;
            // Volatility is useful when chasing a lead, costly when protecting one.
            // This adjusts the value of multiplying exposure, not the card distribution.
            let factor = bomb_factor(&p) as f64;
            let exit = 1.0 / (1.0 + groups as f64);
            value += risk_weight * pressure * (factor - 1.0) * (2.0 + 3.0 * exit);
        }
        // Stable legal-move order breaks ties; suits never convey hidden information.
        if value > best_value {
            best_value = value;
            best = Some(cards);
        }
    }
    if let (Some(ctx), Some(cards)) = (context, best.as_ref())
        && risk_weight > 0.0
        && ctx.rounds_remaining.is_some_and(|n| n <= 2)
        && ctx.own_score > ctx.best_other_score
        && obs.played[obs.turn] > 0
        && obs.last.is_some()
        && obs
            .counts
            .iter()
            .enumerate()
            .all(|(s, &n)| s == obs.turn || n > 2)
    {
        let factor = bomb_factor(&resolve(cards, previous).unwrap());
        // Passing is legal and can avoid paying a doubled loss with a long, weak hand.
        if factor > 1
            && (obs.hand.len() - cards.len()) as i64 * factor > obs.hand.len() as i64
            && shape.cost(shape.full ^ shape.mask(cards)) >= 3
        {
            return None;
        }
    }
    best
}
fn bomb_factor(p: &Pattern) -> i64 {
    match p.kind {
        Kind::Bomb => 2,
        Kind::DeepBomb => 4,
        _ => 1,
    }
}
fn legacy(obs: &Observation<'_>, moves: Vec<Vec<Card>>) -> Option<Vec<Card>> {
    let single = obs
        .counts
        .iter()
        .enumerate()
        .any(|(s, &n)| s != obs.turn && n == 1);
    let previous = obs.last.map(|l| &l.pattern);
    if let Some(c) = moves
        .iter()
        .filter(|c| {
            c.iter().filter(|&&c| c < 52).count() == 2
                && c.iter().any(|&c| c >= 52)
                && bomb_factor(&resolve(c, previous).unwrap()) > 1
        })
        .min_by_key(|c| {
            (
                c.len(),
                if single {
                    15 - resolve(c, previous).unwrap().rank
                } else {
                    resolve(c, previous).unwrap().rank
                },
            )
        })
    {
        return Some(c.clone());
    }
    if single {
        moves.into_iter().max_by_key(|c| {
            let p = resolve(c, previous).unwrap();
            (bomb_factor(&p), p.rank, p.len)
        })
    } else {
        moves.into_iter().next()
    }
}

/// Small exact partition DP; a finite bound prevents pathological large-hand work.
struct Shape {
    hand: Vec<Card>,
    full: usize,
    costs: Vec<u8>,
}
impl Shape {
    fn new(hand: &[Card]) -> Self {
        if hand.len() > 12 {
            return Self {
                hand: hand.to_vec(),
                full: 0,
                costs: vec![],
            };
        }
        let full = (1 << hand.len()) - 1;
        let masks: Vec<usize> = legal_moves(hand, None)
            .iter()
            .map(|c| {
                hand.iter()
                    .enumerate()
                    .filter(|(_, h)| c.contains(h))
                    .fold(0, |m, (i, _)| m | (1 << i))
            })
            .collect();
        let mut costs = vec![30u8; full + 1];
        costs[0] = 0;
        for mask in 1..=full {
            for &play in &masks {
                if mask & play == play {
                    costs[mask] = costs[mask].min(costs[mask ^ play].saturating_add(1));
                }
            }
        }
        Self {
            hand: hand.to_vec(),
            full,
            costs,
        }
    }
    fn mask(&self, cards: &[Card]) -> usize {
        if self.costs.is_empty() {
            0
        } else {
            self.hand
                .iter()
                .enumerate()
                .filter(|(_, c)| cards.contains(c))
                .fold(0, |m, (i, _)| m | (1 << i))
        }
    }
    fn cost(&self, mask: usize) -> u8 {
        if self.costs.is_empty() {
            (self.hand.len() / 2 + 1) as u8
        } else {
            self.costs[mask]
        }
    }
}

struct Unknown {
    ranks: [usize; 16],
    wild: usize,
    total: usize,
}
impl Unknown {
    fn new(obs: &Observation<'_>) -> Self {
        let mut ranks = [0; 16];
        let mut wild = 0;
        let mut total = 0;
        for c in 0..DECK_SIZE {
            if !obs.hand.contains(&c) && !obs.discarded.contains(&c) {
                if c >= 52 {
                    wild += 1;
                } else {
                    ranks[rank(c) as usize] += 1;
                }
                total += 1;
            }
        }
        Self { ranks, wild, total }
    }
    // Hypergeometric tail: probability of k or more relevant cards in a hidden hand.
    fn tail(&self, relevant: usize, n: usize, k: usize) -> f64 {
        if n < k || relevant < k || self.total == 0 {
            return 0.0;
        }
        let n = n.min(self.total);
        let relevant = relevant.min(self.total);
        let mut sum = 0.0;
        for x in k..=n.min(relevant) {
            if n - x <= self.total - relevant {
                sum += combination(relevant, x) * combination(self.total - relevant, n - x)
                    / combination(self.total, n);
            }
        }
        sum.clamp(0.0, 1.0)
    }
    fn response(&self, p: &Pattern, n: usize) -> f64 {
        let mut no_bomb = 1.0;
        for r in 3..=15 {
            let k = match p.kind {
                Kind::DeepBomb => {
                    if r > p.rank as usize {
                        4
                    } else {
                        continue;
                    }
                }
                Kind::Bomb => {
                    if r > p.rank as usize {
                        3
                    } else {
                        4
                    }
                }
                _ => 3,
            };
            // A wildcard-only set is illegal; probability is an approximation, not a proof.
            if self.ranks[r] > 0 {
                no_bomb *= 1.0 - self.tail(self.ranks[r] + self.wild, n, k);
            }
        }
        let regular = match p.kind {
            Kind::Single | Kind::Pair if p.rank < 15 => {
                let k = p.len;
                let next = self.tail(
                    self.ranks[p.rank as usize + 1] + if k == 2 { self.wild } else { 0 },
                    n,
                    k,
                );
                let two = if p.rank == 14 {
                    0.0
                } else {
                    self.tail(self.ranks[15] + if k == 2 { self.wild } else { 0 }, n, k)
                };
                1.0 - (1.0 - next) * (1.0 - two)
            }
            Kind::Straight if n >= p.len && p.rank as usize + p.len < 15 => {
                let mut chance = 1.0;
                for r in p.rank as usize + 1..=p.rank as usize + p.len {
                    chance *= self.tail(self.ranks[r] + self.wild, n, 1);
                }
                chance
            }
            _ => 0.0,
        };
        (1.0 - no_bomb * (1.0 - regular)).clamp(0.0, 1.0)
    }
}
fn combination(n: usize, k: usize) -> f64 {
    if k > n {
        return 0.0;
    }
    let k = k.min(n - k);
    (0..k).fold(1.0, |v, i| v * (n - i) as f64 / (i + 1) as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leading_final_round_can_decline_a_speculative_bomb() {
        let mut g = Game::deal((0..54).collect(), 3, 0);
        g.hands = vec![
            vec![0, 13, 26, 4, 6, 8, 10, 11],
            vec![2, 3, 7, 9, 16],
            vec![5, 14, 15, 17, 18],
        ];
        g.last = Some(LastPlay {
            seat: 2,
            cards: vec![12],
            pattern: resolve(&[12], None).unwrap(),
        });
        g.played[0] = 1;
        let obs = Observation::from_game(&g);
        let ahead = MatchContext {
            own_score: 100,
            best_other_score: 0,
            rounds_remaining: Some(1),
        };
        assert_eq!(
            choose_in_match(&obs, Policy::Adaptive, Some(ahead), 0.5),
            None
        );
        let behind = MatchContext {
            own_score: 0,
            best_other_score: 100,
            ..ahead
        };
        assert!(choose_in_match(&obs, Policy::Adaptive, Some(behind), 0.5).is_some());
        let unlimited = MatchContext {
            rounds_remaining: None,
            ..ahead
        };
        assert_eq!(
            choose_in_match(&obs, Policy::Adaptive, Some(unlimited), 0.5),
            choose(&obs, Policy::Adaptive)
        );
    }
    #[test]
    fn public_match_scores_do_not_grant_hidden_card_access() {
        let mut g = Game::deal((0..54).collect(), 4, 0);
        let ctx = MatchContext {
            own_score: 12,
            best_other_score: 20,
            rounds_remaining: Some(2),
        };
        let before = choose_in_match(
            &Observation::from_game(&g),
            Policy::Adaptive,
            Some(ctx),
            0.5,
        );
        g.hands.swap(1, 2);
        g.deck.reverse();
        assert_eq!(
            before,
            choose_in_match(
                &Observation::from_game(&g),
                Policy::Adaptive,
                Some(ctx),
                0.5
            )
        );
    }
    #[test]
    fn hidden_permutations_do_not_change_decisions() {
        let mut g = Game::deal((0..54).collect(), 4, 0);
        for policy in Policy::ALL {
            let before = choose(&Observation::from_game(&g), policy);
            g.hands.swap(1, 2);
            g.deck.reverse();
            assert_eq!(before, choose(&Observation::from_game(&g), policy));
        }
    }
    #[test]
    fn hundreds_of_hidden_reallocations_leave_every_policy_unchanged() {
        use rand::{SeedableRng, rngs::StdRng, seq::SliceRandom};
        let mut rng = StdRng::seed_from_u64(810);
        for trial in 0..200 {
            let n = 2 + trial % 7;
            let mut deck: Vec<Card> = (0..54).collect();
            deck.shuffle(&mut rng);
            let mut g = Game::deal(deck, n, trial % n);
            let before: Vec<_> = Policy::ALL
                .iter()
                .map(|&p| choose(&Observation::from_game(&g), p))
                .collect();
            let ctx = MatchContext {
                own_score: 20,
                best_other_score: 10,
                rounds_remaining: Some(1),
            };
            let before_match = choose_in_match(
                &Observation::from_game(&g),
                AUTOMATED_POLICY,
                Some(ctx),
                MATCH_RISK_WEIGHT,
            );
            let mut unseen = g.deck.clone();
            for (s, h) in g.hands.iter().enumerate() {
                if s != g.turn {
                    unseen.extend(h);
                }
            }
            unseen.shuffle(&mut rng);
            for (s, h) in g.hands.iter_mut().enumerate() {
                if s != g.turn {
                    for c in h {
                        *c = unseen.pop().unwrap();
                    }
                }
            }
            g.deck = unseen;
            for (i, &p) in Policy::ALL.iter().enumerate() {
                assert_eq!(before[i], choose(&Observation::from_game(&g), p));
            }
            assert_eq!(
                before_match,
                choose_in_match(
                    &Observation::from_game(&g),
                    AUTOMATED_POLICY,
                    Some(ctx),
                    MATCH_RISK_WEIGHT
                )
            );
        }
    }
    #[test]
    fn winning_deep_bomb_maximizes_settlement() {
        let mut g = Game::deal((0..54).collect(), 2, 0);
        g.hands[0] = vec![0, 13, 52, 53];
        assert_eq!(
            choose(&Observation::from_game(&g), Policy::Score),
            Some(vec![0, 13, 52, 53])
        );
    }
    #[test]
    fn avoids_leaving_a_lone_joker() {
        let mut g = Game::deal((0..54).collect(), 3, 0);
        g.hands[0] = vec![0, 1, 2, 52];
        let cards = choose(&Observation::from_game(&g), Policy::Score).unwrap();
        assert_ne!(cards, vec![0, 1, 2]);
    }
    #[test]
    fn unseen_counts_follow_discards_only() {
        let mut g = Game::deal((0..54).collect(), 2, 0);
        g.hands[0] = vec![0, 8];
        g.discarded = vec![1, 14, 27, 40, 12, 25, 38, 51, 52, 53];
        let u = Unknown::new(&Observation::from_game(&g));
        assert_eq!(u.response(&resolve(&[0], None).unwrap(), 1), 0.0);
        g.discarded.clear();
        assert!(
            Unknown::new(&Observation::from_game(&g)).response(&resolve(&[0], None).unwrap(), 1)
                > 0.0
        );
    }
}
