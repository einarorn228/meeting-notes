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

## English spoken inside Icelandic, and why no model setting fixes it

Icelandic meetings are full of English - product names, "up to speed", whole quoted sentences. The recogniser is
fine-tuned on Icelandic, so it writes them the way they sound: a real recording came back with "vorm kittí" for
*warm kitty* and "ýkja forritinu" for *the IKEA app*. The obvious first question is whether a different model, or
Whisper's own language detection, would do better.

Twelve code-switched cuts were built for this: a conversational Spjallrómur utterance, an English phrase from
LibriSpeech dev-clean, then a short Icelandic utterance, with a third of a second between them. The same twelve
cuts went through four arms, and the same twelve Icelandic utterances went through each arm alone for the
accuracy column.

| Model and language | WER, Icelandic alone | Icelandic words back | English words back | Cuts with both |
|---|---|---|---|---|
| **Icelandic fine-tune, `is` (what ships)** | **25.5 %** | **70.8 %** | 3.7 % | 0/12 |
| Icelandic fine-tune, auto-detect | 25.5 % | 70.8 % | 3.7 % | 0/12 |
| large-v3-turbo, `is` | 48.4 % | 65.3 % | 5.6 % | 1/12 |
| large-v3-turbo, auto-detect | 48.4 % | 49.9 % | **23.1 %** | 1/12 |

The fine-tune returns 3.7 % of the English - which is to say none of it; what little counts as "back" is short
words that also exist in the Icelandic. Auto-detect changes nothing at all on it: the output is identical to the
character, because the model recognises its own language every time.

The multilingual model does hear the English, and that is exactly where the see-saw shows. Whisper decodes one
language per cut, so what the arm gains in English it loses in Icelandic - 70.8 % down to 49.9 % - and no arm
manages both at once in more than one cut out of twelve. It is not a matter of degree; it swaps which half of
the sentence survives:

```
spoken:      [Icelandic about earthquakes] "Nor is Mister Quilter's manner less interesting than his matter."
fine-tune:   já við erum að lifa lifa með því hún er mjög æst út í út í fólk sem er svona að þvælast í í í
             nágrenni við okkur                                        (English: gone without trace)
turbo, auto: Nor is Mr. Quilter's manner less interesting than his matter.   (Icelandic: gone without trace)
```

And it costs the Icelandic twice over: 48.4 % WER against 25.5 % on the same twelve utterances, on speech with no
English in it at all.

So there is no recogniser setting to reach for, and the model picker's descriptions now say so in those numbers.
What remains is where the app already reads the whole transcript: the pass that restores punctuation is told
that the recogniser writes foreign words phonetically, and writes them back in their own spelling **when the
context makes the word unmistakable** - leaving them alone otherwise, because a guess here would be a
fabrication in the user's own record. The vocabulary list reaches that pass too, which is why English terms
belong in it (and why they must stay out of the recogniser - see the section above).

## Where the word errors actually are

Sixty utterances of Spjallrómur (332 s, 22 speakers, every conversation in the shard), through the engine
exactly as the app runs it - beam 5, int8, no prompt: 31.3 % WER as scored. Eight of the sixty, all from one
conversation (`198f2863`), score 96.6 %, and those eight are not the recogniser's doing: in that conversation
the audio in a row does not belong to the row's text. What the model wrote for row 0082 ("það er ekkert betra
en ísköld mjólk sko") is, word for word, the reference of row 0112 ninety seconds later; row 0047's output is
row 0066's reference; and rows 0355–0447 carry byte-identical audio. It is the corpus's known alignment
problem, and that conversation has been in every sample drawn from this shard, so the error rates above this
section are a few points worse than the recogniser is.

Without it: 52 utterances, 840 words, **22.0 % WER** - 20.8 % once the reference's own artefacts are dropped
(`[HIK:…]` hesitation tags, `[UNK]`, "þ ú" split in two). For scale, the corpus authors' own run of the RU
30k-steps model on the Spjallrómur test set reports 41.7 %. What the 22 % is made of:

| | Words | Of the reference | What it is |
|---|---|---|---|
| Deletions | 94 | 11.2 % | 83 real words and 11 fillers. 33 sit in the last two words of an utterance, and 9 utterances of 52 lose their whole tail ("…spennt að halda áfram" came back as "…spennt að"). |
| Substitutions | 59 | 7.0 % | 24 are within two letters of the right word (myndir/myndirðu, vill/vil, þessum/þessu): grammar the model got wrong on a word it heard. 35 are a different word. |
| Insertions | 32 | 3.8 % | Stutters kept as said ("en en en"), and the other speaker's words where the reference leaves them out ("af hverju má ekki segja nafnið"). |

By length: 16.6 % on utterances up to 4 s, 22.8 % at 4–8 s, 24.9 % above 8 s.

Two things follow. The largest single item is words dropped at the end of a cut, which is a property of how
the model stops, not of what it heard. And the next largest is near misses of inflection and a stutter kept -
errors a reader of the whole sentence fixes without hearing the audio, which is what the AI pass is for, and
why the user's corrections now go to it (below).

## What the user's corrections teach the app

The recogniser cannot be taught a word (the vocabulary section above), but the app can remember what the user
fixed. When a transcript line is edited, the words that changed are stored as (recogniser wrote → user wrote)
pairs - anchored on the words that stayed, at most four words a side, never a rewrite, never a dropped filler,
never punctuation alone. A pair the user has made twice is applied to new lines by itself (whole words,
case-insensitive, a capital kept at the start of a line); all of them go to the AI pass as examples, most
frequent first. `src/main/corrections.ts`; the list is under Settings → Vocabulary, with a way to forget one.

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
