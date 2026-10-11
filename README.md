# Subtitle Studio

Drop in a video or a song. It hears every word, puts each one on screen at the
moment it's sung, and gives you five caption looks to choose from. Fix any word
by typing over it, change any setting you like, then export a finished MP4, a
transparent overlay for Premiere, or an .srt file.

Everything runs on your PC. Nothing is uploaded anywhere.

---

## Start it

Double-click **`Start.bat`**.

The **first run** sets itself up: it builds a private Python environment in the
`venv` folder, installs PyTorch for your RTX card, and downloads the models
(about 7 GB). Plan on 10-25 minutes, once. After that it opens in seconds.

You also need **ffmpeg**. If you can already export from the Subtitle Animator
next door, you have it. If not, run `winget install Gyan.FFmpeg` and start again.

To check everything is working, run:

```
venv\Scripts\python tools\check_setup.py
```

It loads each model on the GPU and tells you which parts are ready.

---

## How it works

1. **Drop a file** on the home screen: MP4, MOV, MKV, WebM, MP3, WAV, M4A or FLAC.
2. Set **Language** to English, Spanish, or leave it on *Detect automatically*.
   Leave **Isolate the vocal first** on for songs.
3. Optional: **paste your lyrics.** Every line then comes out exactly as you
   wrote it, timed to the track. This is the most accurate way to work, because
   you know your words better than any model does.
4. Optional: add **names and slang** for it to listen for (Iration, mae, pura vida).
   Qwen3-ASR uses them as context.
5. Wait for the progress card. A 3-minute song takes well under a minute on a 4090.
6. The editor opens.

### The editor

| Where | What you do there |
|---|---|
| **Words** (left) | Click a word to jump to it. **Double-click a line** to retype it. Press Enter to save, Shift+Enter to split the line at the cursor, Esc to cancel. **Alt-click** a word to make it a key word, which gets its own colour and size. Use ↻ to re-sync a line, ↧ to join it with the next one, and × to delete it. |
| **Preview** (middle) | Click to play or pause. **Drag the caption** to move it. *Reels / TikTok / Shorts guides* shade the areas each app covers with its buttons and caption. |
| **Timeline** (bottom) | **Drag a word's edge** to change where it starts or ends. Drag the word to slide it, or drag the line bar to slide the whole line. Scroll to move along, Ctrl+scroll to zoom. |
| **Look** (right) | Pick one of the five looks. Everything under it is fine-tuning. **Save this look** keeps your version under *My looks* for the next song. |

**When you fix a word, the line re-syncs to the audio by itself.** The words you
didn't touch keep their exact timing. The new words are placed against the
actual vocal by the forced aligner, so they stay in time. Turn off the checkbox
under the word list if you'd rather re-sync by hand. Lines that changed show in
amber until they're synced.

Other tools in the top bar:

- **Find & replace**: fix a name the model keeps mishearing, everywhere at once.
- **Use my lyrics**: paste the lyrics after the fact. They replace the words and
  are timed to the track.
- **Transcribe again**: start over with a different language or engine.

Ctrl+Z / Ctrl+Shift+Z undo and redo everything, including look changes.
Your work saves automatically.

| Key | Does |
|---|---|
| Space | play / pause |
| ← / → | back / forward 1 s (with Shift: 5 s) |
| Enter | edit the selected word's line |
| Ctrl+Z, Ctrl+Shift+Z | undo, redo |

### Songs with no video

Drop an MP3 or WAV and you get a frame to put the captions on. Choose its shape
(9:16 Reels, 4:5 feed, 1:1, 16:9) and a background colour or image in the bar
under the preview. The export becomes a video of that frame with your audio.

---

## Export

| Format | Use it for |
|---|---|
| **Video with captions** | MP4 with the captions burned in, ready to post. It is encoded on the 4090 with NVENC, and the audio is copied untouched when it can be. |
| **Captions only, transparent** | ProRes 4444 `.mov` with a real alpha channel. Drop it on a track above your footage in Premiere or After Effects. If AE asks, interpret the alpha as *Straight - Unmatted*. |
| **Subtitle file** | `.srt` with one cue per line, wrapped at 42 characters. Use it for YouTube, Premiere captions, or VLC. It carries no styling. |

Files land in the `output` folder. The finished message has a **Show in folder** button.

The preview and the export are drawn by the same code, frame by frame, so the
file looks exactly like what you saw.

---

## The recognition engine (why not just Whisper)

RapSubtitles uses faster-whisper large-v3-turbo, which is fast and good. For
finished songs there is now something clearly better. Subtitle Studio uses:

1. **BS-RoFormer** (via python-audio-separator) to pull the lead vocal off the
   beat first. This is one of the strongest open vocal-separation models. Recognisers
   and aligners are far more accurate on a clean vocal. One published test on a
   rap track matched 8 of 20 lines from the full mix and 19 of 20 from the vocal stem.
2. **Qwen3-ASR-1.7B** (Alibaba Qwen, open source, Jan 2026) to hear the words.
   On Qwen's published singing benchmarks it roughly halves Whisper-large-v3's
   error rate:

   | Word error rate (lower is better) | Whisper-large-v3 | Qwen3-ASR-1.7B |
   |---|---|---|
   | M4Singer (sung vocals) | 13.58% | **5.98%** |
   | MIR-1k vocals | 11.71% | **6.25%** |
   | Popcs | 13.77% | **8.52%** |

   It also scores 14.6% on whole songs *with* the beat still in. It covers 30
   languages including English and Spanish, and takes your lyrics and slang as context.
3. **Qwen3-ForcedAligner-0.6B** to place every word in time. Its average timing
   error is 32-53 ms, against about 133 ms for WhisperX, the usual tool for word
   timestamps. The same aligner re-syncs a line when you edit it and times your
   pasted lyrics.

**Whisper large-v3-turbo stays in as a fallback.** If the Qwen models can't
load for any reason, Whisper is used automatically and the progress card tells you so.

Models live in `models\` inside this folder. Delete that folder to reclaim the
space; they download again when next needed. `Qwen3-ASR 0.6B` is offered as a
faster, slightly less accurate option.

---

## Why these five looks

Five looks rather than nineteen. Each one is built on what the caption world
actually uses, not on what looked good once. All fonts are SIL Open Font
License, so they're free to use in monetised and released videos. They ship
with the app, so exports never depend on an internet connection.

**Viral Bold.** This is the short-form standard, the Hormozi / MrBeast lineage:
Montserrat Black in capitals, 2-3 words at a time, white with a heavy black
outline and soft shadow. The spoken word turns yellow (#FFD93D), and key words
turn green. It sits about 63% of the way down the frame, which is the band
creators use to clear TikTok's and Reels' bottom UI. This setup is the
documented consensus: Montserrat 900, all caps, 1-3 words, a black stroke of
about 8-12 px on 1080×1920, placed 60-70% down.

**Highlight Box.** A coloured box slides from word to word under the voice.
This is the most-copied look from CapCut, Submagic and OpusClip right now, and
caption-font guides list Montserrat/Poppins ExtraBold as its usual faces. Here it
uses Poppins 800 in sentence case with an acid-lime box and dark text on the box.

**Synced Lyrics.** Modelled on Apple Music Sing and Spotify's synced lyrics,
the lyric display people already know from their phones. The line fills in word
by word as it's sung, with a soft leading edge and a glow on the sung part. The
next line waits underneath, dimmed. It uses Inter 800, left-aligned. This is the
musical one.

**Cinematic.** Film-subtitle restraint for moody edits and slower songs.
Instrument Serif italic, the serif behind a lot of current "aesthetic" type.
Song lyrics are italic per Netflix's subtitle style guide. Each line is up to
two rows and 42 characters, which is the Netflix limit. Words breathe in out of
a soft blur as they're sung, with no outline, just a deep soft shadow.

**Rap Kinetic.** For verses. Anton capitals, 1-2 words at a time, huge. Each
word slams in as it lands. **Word size follows how hard you hit it**: loudness
is measured word by word from the isolated vocal, the same idea as RapSubtitles.
The loudest words turn red and shake. A hard offset shadow and a slight random
tilt give it the hype-edit feel. Anton is the face caption guides name for this kind of look.

Each look has its own placement and size for a 16:9 frame, used automatically on landscape video.

**On the evidence.** Most "this style gets X% more views" figures online come
from caption-tool companies grading their own homework, with no sample sizes. So
these looks lean on what is measurable and stable: subtitle standards (42
characters per line, max 2 lines, about 20 characters per second), the platforms' UI
safe zones, legibility basics (heavy weight, big x-height, an outline or shadow
over unpredictable footage), and the styles' own documented specs. Treat any
look as a starting point and test on your own audience.

### Settings, in plain words

Sizes are relative, so a look keeps its proportions at any resolution:
*Size* is % of frame height, outline / shadow / padding are fractions of the
letter size (em), and position is % of the frame.

- **Show**: a few words at a time, the whole line, or a line plus the next line (lyrics).
- **Spoken word**: changes colour, gets a box, gets an underline, or fills in as sung.
- **Words appear**: all together when the caption comes up, or one by one as they're spoken.
- **Not-yet-sung words**: how visible the upcoming words are (0 hides them).
- **Emphasis**: louder words bigger or coloured, random tilt, shake on loud words.
- **Timing**: how early a caption appears, how long it holds, and which short gaps it bridges so captions don't flicker.

---

## If something goes wrong

**The status line on the home screen is red.** It says which part is missing.
Running `setup.bat` again fixes most things, because finished steps are skipped.

**"Qwen3-ASR could not run... Whisper was used."** The reason is in
`studio.log`. Run `tools\check_setup.py` to see it on its own.

**Setup fails on PyTorch.** Your NVIDIA driver may be older than CUDA 12.8.
Run `setup.bat cu126`, or update the driver.

**The preview says the browser can't play the file.** Open the page in Chrome
or Edge. Odd formats (ProRes, 10-bit, MKV) get a preview copy made
automatically. The export always uses your original file.

**Captions are slightly early or late everywhere.** Use *Timing → Show before
the voice* for the feel. To fix the words themselves, drag them on the timeline.

**A word came out wrong.** Double-click the line, retype it, press Enter. The
line re-syncs to the audio.

---

## Files

| | |
|---|---|
| `Start.bat` | Starts the app (sets it up on first run). |
| `setup.bat` | Builds `venv`, installs PyTorch (CUDA) and the packages, then downloads the models. |
| `server.py` | Local web server, upload, export endpoints. |
| `studio/asr.py` | Qwen3-ASR + forced aligner, Whisper fallback, model downloads. |
| `studio/separate.py` | BS-RoFormer vocal isolation. |
| `studio/lines.py` | Punctuation-preserving word mapping, line breaking, loudness, lyric matching. |
| `studio/pipeline.py` | The GPU job queue: transcribe, place lyrics, re-sync edited lines. |
| `studio/exporter.py` | ffmpeg export: burn-in MP4, ProRes 4444 overlay, audio-only video. |
| `web/renderer.js` | The caption renderer, shared by the preview and the export. |
| `web/presets.js` | Every setting, its control, and the five looks. |
| `web/app.js`, `web/timeline.js` | The editor. |
| `web/fonts/` | The 33 caption fonts (OFL / Apache), bundled. |
| `projects/` | One folder per upload: original, vocal stem, transcript, look. |
| `output/` | Your exports. |
| `models/` | Downloaded models (~7 GB). Safe to delete. |
| `my_presets.json` | Your saved looks. |
| `tools/check_setup.py` | Verifies GPU, ffmpeg, and that each model loads. |
| `tests/` | Logic tests and a stand-in server used during development. |

---

## Sources

- Qwen3-ASR and Qwen3-ForcedAligner, benchmarks and usage: <https://github.com/QwenLM/Qwen3-ASR>, <https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B>
- Open ASR model comparison (July 2026): <https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/>
- python-audio-separator (BS-RoFormer): <https://pypi.org/project/audio-separator/>
- Vocal stem vs full mix for lyric alignment: <https://github.com/ijuinryukichi/lyric-align>
- Netflix English Timed Text Style Guide: <https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide>
- Hormozi caption specs: <https://ascynd.io/en/blog/hormozi-captions>
- Caption fonts and creator styles: <https://www.captionplug.com/blog/best-fonts-for-video-captions>, <https://www.clipspeed.ai/blog/best-fonts-for-captions.html>
- Caption style conventions: <https://recapo.ai/blog/best-caption-styles-for-shorts/>, <https://www.clipspeed.ai/blog/11-caption-styles-ranked-viral-performance-2026.html>
- Platform safe zones: <https://adaptlypost.com/en/blog/social-media-safe-zones-2026-complete-guide>
- TikTok Sans (open source, included in the font list): <https://developers.tiktok.com/blog/tiktok-sans-open-source>
