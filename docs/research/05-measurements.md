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

## Whether the vocabulary list helps the recogniser (it does not)

Settings has a list of names and terms for the meeting. Until 0.1.13 it was handed to Whisper as its
`initial_prompt`, which is what the Whisper paper says to do and what every other transcription app does. On the
Icelandic fine-tunes it is close to the worst thing you can do.

30 Spjallrómur utterances that contain a proper noun, each transcribed twice by the app's own engine - once with
nothing, once with that utterance's own name plus 20 plausible meeting terms in the prompt:

| | WER | The name came out | Time for the 30 |
|---|---|---|---|
| **No prompt (now)** | **21.2 %** | **85.7 %** | **246 s** |
| Name in the prompt (was) | 94.6 % | 23.8 % | 2 059 s |

Both halves of the promise fail at once. The transcript falls apart, and the name the list was there to protect
is *less* likely to appear than if the list had been empty. The cost is not subtle either: 8× the processing,
and single four-second utterances taking 145, 153, 176 and 206 seconds.

What goes wrong is visible utterance by utterance. The fine-tunes were trained to emit bare lowercase speech;
a list of names in front of that is unlike anything in their training, so they drop words and invert meaning -

```
plain: já já það náttúrulega gengur upp ég skil það nú mjög vel
vocab: jájá það náttúrulega gengur ekki é skil það nú mjög vel

plain: nei þetta hafði nú verið eitthvað sem var búið að koma fyrir í frystunum í í
vocab: nei þetta hafði nú verið eitthetta hafði einhver sem var búið að koma fyrir í frystinum í í í
```

- and often enough to matter they run away repeating the prompt, which trips Whisper's own quality thresholds
and forces a re-decode at every fallback temperature. That is where the 176-second four-second utterance comes
from, and on a real meeting it is what a growing backlog and a transcript minutes behind the speech looks like.

It is not about whether the name is in the audio either. On utterances with no proper nouns at all, the same
plausible-but-irrelevant list does the same damage: over the first three utterances of that set, 13.5 % WER and
6-11 s each without it, 105.8 % WER and 116-219 s each with it. (That arm was stopped after three; at two
minutes an utterance it had already answered the question.)

So the prompt is gone for any model that writes no punctuation - which is the same line that separates the
Icelandic fine-tunes from stock Whisper. The list still does the two things that were never at risk: it puts
the canonical spelling back into the finished text, and it goes to the AI pass, which fixes names from context
instead of guessing at them mid-decode.

## Transcribing queued cuts together, and what it costs

When the machine is slower than the speech, the cuts waiting on one channel are transcribed in a single model
call. Whisper always processes a 30 s window, so a short cut costs nearly as much as a long one, and this is
what turns a growing backlog into a shrinking one. The question is what the text loses.

12 runs of 4 consecutive utterances by one speaker (Spjallrómur, ~240 s of speech), decoded k at a time - k=1
is the app when it keeps up, k=4 is a machine well behind:

| Cuts per call | WER | Words returned | Time for the 240 s |
|---|---|---|---|
| 1 | 32.6 % | 85.9 % | 601 s |
| 2 | 31.3 % | 81.2 % | 479 s |
| 3 | 33.2 % | 80.9 % | 409 s |
| 4 | 33.7 % | 80.5 % | 321 s |

Merging costs about five percent of the words, all of it at the first merge, and nothing measurable in word
error rate, for nearly twice the throughput. It stays.

What did not stay is how far apart two cuts could be and still be merged. A merged line carries the start of
the first cut and the end of the last, and the window allowed 60 seconds between them - so one line could
cover the other person's replies, and the transcript printed answers before the questions that prompted them.

Measured on a real 6:39 two-person call recorded with the app (a user's own recording, replayed through the
app's streaming code at live speed):

| | Lines | Median span | Longest line | Lines longer than one model call |
|---|---|---|---|---|
| As recorded, 0.1.12 | 36 | 9.0 s | 55.0 s | 9 |
| Current code, 60 s window | 57 | 5.5 s | 26.6 s | 3 |
| **Current code, 3 s window** | **58** | **3.6 s** | 27.9 s | **1** |

The word count is the same in all three (507 / 502 / 498); what changes is that the words are where they were
spoken. Three seconds is what separates two sentences of one turn from two turns - a cut needs 900 ms of quiet
before it closes at all - so the backlog is still worked down in single calls.

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
