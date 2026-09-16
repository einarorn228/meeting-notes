# What was measured, and what it decided

Every number here comes from running the app's own code over audio with known ground truth, in this build
environment (4 vCPU x86-64, no GPU, faster-whisper 1.2.1 int8, beam 5). The corpus is **Spjallrómur**, the
Icelandic conversational corpus: real two-person conversations with per-utterance transcripts, speaker labels
and timings, which is what makes error rates and speaker counts checkable rather than a matter of impression.

## How long a pause ends a sentence (`min_silence_ms`)

The app cuts a line of transcript when the speaker has been quiet for this long. Too short and one sentence
becomes several fragments, each transcribed without the context of the rest, each costing a full model call.

Two disjoint samples of one speaker's side of real conversations:

| Pause | Sample A: cuts | Sample A: WER | Sample A: RTF | Sample B: cuts | Sample B: WER |
|---|---|---|---|---|---|
| 600 ms (was) | 67 | 27.2 % | 0.55 | 127 | 20.6 % |
| **900 ms (now)** | 57 | **26.3 %** | **0.49** | 114 | 20.7 % |
| 1200 ms | 53 | 26.6 % | 0.47 | – | – |

900 ms was chosen: accuracy is unchanged within measurement noise, there are 10–15 % fewer lines, each is a
fuller sentence, and the model is called less often. Waiting longer still buys nothing and delays the text.

## How short a voice may be before it is trusted (`MIN_RELIABLE_S`)

Clustering produces far more clusters than there are people; the app then absorbs the ones too short to judge
into the nearest reliable voice. The threshold used to be 4 seconds, which is where one person became a crowd
on a long recording. Two voices, 40 minutes, 135 raw clusters:

| Floor | Speakers found (truth: 2) | Completeness |
|---|---|---|
| 4 s | 20–40 | 0.77–0.91 |
| 10 s | 2–9 (depends on the merge threshold) | 0.89–0.98 |
| **20 s** | **2** | **0.99** |
| 30 s | 2 | 0.99 |

20 s holds on all eight ground-truth cases, including the ones that used to fail:

```
your meeting, the other side:  2.9 min, expected 1, found 1
your meeting, your own mic:    2.9 min, expected 1, found 1
real conversation, 15 min:    15.0 min, expected 1, found 1
real conversation, 60 min:    60.0 min, expected 2, found 2
built: 1 voice, 40 min:       40.4 min, expected 1, found 1
built: 2 voices, 20 min:      20.2 min, expected 2, found 2
built: 3 voices, 20 min:      20.2 min, expected 3, found 3
built: 2 voices, 40 min:      40.5 min, expected 2, found 2
```

On a recording too short for anything to reach 20 s, the longest cluster is used as the floor instead -
otherwise the absorption step is skipped entirely and a three-minute call comes back as eighteen participants.

## An hour-long meeting, fed through the app in real time

A 60-minute two-person Spjallrómur conversation streamed at 1× through the sidecar on these four slow cores:
the queue of cuts waiting for text rose and fell all the way through (single digits most of the time, tens at
its worst) without trending upwards, and the last cut was written **20 seconds after the stop button**. The
machine is slower than the speech during bursts and faster than it in the gaps, which is what keeps it bounded.

## Recognising a voice from an earlier meeting (not shipped)

If a voice could be recognised again, naming someone once would be enough. Measured with the app's own speaker
embeddings (ERes2Net), each speaker's utterances split into two halves standing in for two meetings, 30 s of
speech per half, 22 voices with enough speech to qualify:

| | min | median | max |
|---|---|---|---|
| Same voice, two halves | 0.577 | 0.864 | – |
| Two different voices | – | 0.150 | 0.883 |

There is no threshold that separates them cleanly. The two highest "different voice" pairs are a `kona/fertugt`
matched with another `kona/fertugt` and a `karl/tvitugt` with another `karl/tvitugt` in different sessions,
which are quite possibly the same people recorded twice - the corpus does not say - but that cannot be assumed.
At 0.70 the split is 91 % of returning voices recognised against 4 pairs in 462 that would be confused.

Putting someone's name on the wrong voice is worse than not offering it, so this is not shipped as automatic
labelling. What shipped instead is the part that carries no such risk: the rename box offers the names from the
meeting invitation and the names used in earlier meetings, one click each.
