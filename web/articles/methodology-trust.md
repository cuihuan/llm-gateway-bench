When choosing a gateway, the last party you want to trust is the benchmarker itself. Whether a rating site took money, how the weighting formula was tuned, whether the data was hand-picked for flattering moments — these black boxes are harder to falsify than the gateways themselves. So this piece isn't about how objective we are; it's about **exactly how we measure, where the data lives, and how you can reproduce every number with your own key**. Only a reproducible methodology earns the right to talk about trust.

## Dial-testing, not load-testing

The whole platform does one thing: **GitHub Actions runs a round of black-box probing every 6 hours**, with results committed back to the repo each time. The cron is hard-coded as `'17 */6 * * *'` — roughly 4 UTC time slots per day, filling out the time-of-day profile across days.

For each gateway × model, a single round takes `--samples 3` samples, and percentiles are computed via linear interpolation for p50/p95. **Probes within a round are sent serially, never blasted concurrently** — this is the red line of dial-testing: we want to measure how a gateway really feels under normal load, not its rate-limit threshold. Treating it as a load test would measure a success rate from outages you created yourself, with zero reference value for real-world use.

> The question we answer is "is this smooth for an engineer using it normally", not "can I knock it offline". The methodologies for those two are exactly opposite.

## Three engineering red lines that keep the data uncontaminated

**Random strings defeat caching.** Every probe prompt has a random request id appended to its tail — for example, asking the model to count from 1 to 50 and then append `Ignore this request id: a3f9k2`. Relays often cache a response and replay it disguised as streaming; a fixed prompt would have us measuring a cache hit rather than real generation. Swapping the random string on every send invalidates the cache.

**Multi-sampling, report percentiles.** Shared runners have noisy neighbors, so a single latency reading is noise, not signal. We sample the same combination multiple times and report p50/p95 instead of a lone average — only p95 exposes long-tail jitter.

**Record real timestamps.** GitHub cron has scheduling jitter of 15+ minutes, so the nominal "every 6h" and the actual trigger time often don't match. Every round writes real ISO timestamps for `startedAt`/`finishedAt`, and the time-of-day profile is aggregated by that real moment rather than the schedule — otherwise the attribution of peak drift gets skewed by cron jitter.

## Auth exclusion: don't blame the gateway for our own config problem

The probe's own key might not have a given model enabled or might hit a whitelist, returning `401/403`. That's **our configuration problem, not a gateway outage**. During aggregation we exclude auth errors from the denominator per sample, and separately disclose "auth excluded ×N" on the stability panel. This fairness rule is written directly into `probe/aggregate.mjs`:

- `429` rate-limit, `5xx` outage, timeout — counted separately into the error breakdown; they mean completely different things.
- `401/403` auth failure — removed from the denominator, disclosed in its own column, doesn't pollute the success rate.

This convention follows OpenRouter's definition of uptime: **successes ÷ total, excluding user-side errors.** Mixing them in only distorts the leaderboard.

## No black-box score

This is a matter of principle. Any weighted composite score will inevitably be questioned on its weights, and once weights are tunable the leaderboard becomes a manipulable story. So the leaderboard **defaults to sorting by 30-day stability, with every other dimension as its own column**: trust rating, price index, TTFT, tool-call fidelity, CJK integrity, usage fingerprint… sort by whichever column you care about.

The one derived number is the **price index**: gateway price ÷ official price for the same model, with input/output ratios first averaged arithmetically and then geometric-mean'd across models (official price from the litellm open price library). The formula is public, the two raw price columns are listed too, and you can check it yourself.

## Behavioral fingerprints, not claims

Channel origin can't be directly "proven". Our stance is to profile a gateway with a set of black-box-measurable signals — whether model echo matches, whether tool calls get stripped, whether streaming is fake, whether CJK output is corrupted, whether long context gets tail-truncated, whether usage's charsPerToken is anomalous.

And we **presume no guilt**: a single failure draws no conclusion; what counts is sustained behavior over many runs, convincing only when drawn as a time series. This is also the long-term value of this dataset — the longer it runs, the harder the curve, and a new shop can't fake it. A set of background numbers worth remembering: the CISPA audit found 45.83% of endpoints fail model-fingerprint verification, with paid usage actually delivering about 38% of the tokens; of 92+ relay products, most have no company registration or ICP filing. Claims are worthless; sustained behavioral fingerprints are what's valuable.

## Manual annotations carry evidence, and accept PR corrections

Policy-class information (legal-entity qualifications, data retention, whether invoices are available) can't be automated and must be annotated by hand. The rule is hard: **every annotation must carry an evidence link and an annotation date, and anything missing an evidence link never gets "verified"**. Got it wrong? PRs to fix it are welcome. The gateway list likewise accepts self-service PR submissions.

## How you reproduce it yourself

The entire probing code, detection prompts, aggregation logic, and raw data are all open source. The raw JSON is committed per round in `data/results/`, and every number traces back to a specific round and timestamp.

Reproducing with your own key takes three steps:

- Export the gateway key to the matching environment variable (e.g. `export OPENROUTER_API_KEY=...`);
- Run `node probe/probe.mjs --samples 3 --gateway <id>` — the console prints per-item results for TTFT, tok/s, tool calls, CJK, and needle directly;
- Run `node probe/aggregate.mjs` to see the aggregation convention and compare against the leaderboard.

If your reproduced results don't match ours, that itself is a valuable signal — maybe the gateway is treating you differently by IP/region, or maybe we measured something wrong. Either way, open an issue. **The only privilege a benchmarker should have is to be verified.**
