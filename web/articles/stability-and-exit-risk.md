Before you ordered you tested once — pretty latency, 100% success rate — so you topped up a year's worth. Three weeks later, every night at 8pm it starts queuing and freezing, and your tickets get read but not answered; another month and DNS resolution fails, the group chat is disbanded. This isn't a fluke — it's the typical lifecycle of a relay.

## The lifecycle of a cheap relay

Cheap is usually not the destination but the funnel's entrance. A common trajectory:

- **Acquisition phase**: well below official prices to pull in new users, experience cranked to the max, building word-of-mouth and amassing top-ups.
- **Congestion phase**: as users pile on and upstream cost rises, **peak-hour throttling** begins — usable during the day, queues and `429` floods at the evening peak, the multiplier quietly bumped from 1.3 to 1.5 without notice.
- **Outage phase**: an upstream ban wave hits the account pool (community records put ~70% of it down to dirty data-center IPs getting risk-flagged), and the success rate collapses for whole stretches.
- **Exit phase**: service degrades, the domain vanishes, refunds are nowhere to be found. The background data isn't encouraging: industry tallies show **92+ relay products mostly without company registration or ICP filing**, so the legal entity was hard to hold accountable in the first place.

These incidents share one thing in common: **they happen after you've paid, not at the moment you tested.**

## Why a one-off snapshot isn't enough

A single probe before ordering is essentially the tested party's home turf, at a time you picked. It can't measure the three deadliest things:

- **Time-of-day-dependent degradation**: peak-hour throttling only appears in specific UTC hours, and a midnight test will never see it.
- **Intermittent failures**: occasional `5xx`, occasional timeouts — a single sample most likely misses them.
- **Survival trend**: a site on the way down still looks pristine in today's snapshot — decay is a slope, not the value at a single point.

> A single data point can be staged, but **the slope and the persistence can't lie**. This is exactly the long-term value of accumulated data: the longer it runs, the more convincing the curve, and a new shop can't fake history.

## How the platform measures

The platform black-box probes once every 6 hours via GitHub Actions (about 4 slots per day, filling out across days), settles each result into a time series, and statically renders it. The stability dimension lands on these specific quantities (aggregation logic in `probe/aggregate.mjs`):

- **30-day / 7-day rolling success rate**: `uptimePct` and `uptime7dPct`. The 30-day shows the long-term foundation, the 7-day shows whether things have recently gotten worse — read both together to spot a downtrend.
- **Auth exclusion**: the probe's own key returning `401/403` (model not authorized, whitelist) is excluded from the denominator per sample, and disclosed separately as "auth excluded ×N". That's our config problem, not its outage — **no presumption of guilt**.
- **Error breakdown**: failures aren't lumped together but split into `429` (rate-limit) / `5xx` (outage) / `timeout` / `other`. They mean completely different things: rate-limiting is a capacity/policy issue, 5xx is the upstream really crashing, timeout is network or queuing.
- **Time-of-day profile and peak drift**: TTFT and success rate aggregated by UTC hour, `peakDrift = slowest-hour TTFT ÷ fastest-hour TTFT`. **≥2× goes red** — direct evidence of "peak-hour throttling/freezing".
- **TTFT trend + survival history**: a daily TTFT p50 curve, plus a per-day status band (green = success rate ≥99%, yellow = ≥80%, red = <80%, gray = no data), so you can see at a glance which day it collapsed and for how long.

The time window is strictly capped at 30 days; earlier history lives only in the raw data under `data/results/` and doesn't affect leaderboard numbers — but it documents "how long this shop has lived, and how long it stayed stable".

## How to read the leaderboard

Mapping to the leaderboard's columns, here's how to read stability:

- **Look at the 7-day vs 30-day gap first.** A 7-day clearly below the 30-day = getting worse; be wary, the acquisition phase is over.
- **Don't read only the total success rate in the error column.** High `429` = it'll throttle you at peak; high `5xx`/`timeout` = unstable upstream or on the edge of an exit.
- **Take a red peak drift seriously.** `peakDrift ≥ 2` means it's slowest exactly when you're busiest — fatal for high-frequency Agent scenarios.
- **Watch the continuity of the survival band.** A stray gray/red day or two isn't fatal; consecutive red is the incident.

The leaderboard defaults to sorting by 30-day stability and does **no black-box weighted score** — each column is independent, and you sort by whichever you care about most.

## Action plan for readers

- **Dip a small amount, don't go all in.** Top up a little and let it run on the leaderboard for a few more weeks; the time series does the due diligence for you, at the cost of a few cups of coffee.
- **Read the history, not the ad.** "Official direct connection" and "never throttled" are claims; [channel origin can't be proven by claims](methodology-trust) — sustained behavior over many runs is the evidence.
- **Treat peak drift as a hard metric.** Your real load is at the evening peak, so don't trust good numbers from a midnight run.
- **Stability is only half — read it with fidelity.** Cheap and stable can still mean substituting models and inflating tokens; stability answers "is it there", behavioral fingerprints answer "is it the real thing". However low the price, it must first clear the [price index](price-index) to confirm there's no hidden multiplier.

In a sentence: **don't buy the snapshot, buy the curve.** A single test proves no long-term promise; the only thing that proves it is the line drawn by running continuously.
