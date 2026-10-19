# Local Image Lab

Make pictures and videos with AI on your own Windows PC. Once it is installed, everything runs
on your computer. There is no account, no subscription and no cloud service.

- **Pictures:** Qwen Image 2.1 Turbo and FLUX 3 Image Klein. Create, edit and combine images.
- **Video:** MiniMax H3. Turn a description, a picture, or reference pictures, video and sound into a clip with audio.
- **Continuous movies:** clips can carry on automatically into a longer film. In Guided mode a
  local "director" handles the story. Qwen3-VL 4B watches each clip and Qwen3.5 9B writes the
  next scene. At the end it names the film and closes on a title card.

---

## Install (Windows 10 or 11)

1. On this page, click the green **Code** button, then **Download ZIP**.
2. Open your **Downloads** folder, right-click **local-image-lab-main.zip** and choose **Extract All...**
   Choose a drive with at least **90 GB free**, for example `C:\Local Image Lab`, then click **Extract**.
3. Open the extracted folder and double-click **Install.cmd**.
   - If Windows asks *"Do you want to run this file?"*, click **Run**.
   - If a blue box says *"Windows protected your PC"*, click **More info**, then **Run anyway**.
4. Leave the black window open while it downloads about **74 GB**. This usually takes several
   hours, so on a slow connection leave it running overnight. If it stops, or you close it,
   double-click **Install.cmd** again. It carries on where it left off.
5. When it says **Local Image Lab is installed**, double-click the new **Local Image Lab** icon on
   the desktop. The app opens in your web browser.

The first time the app has nothing else to do, it makes two short test videos by itself, which
takes about 25 minutes on a 16 GB card. Let them finish once. They check that video and sound work
on your PC. You can watch them on the Video page.

## Using it

- Open it with the **Local Image Lab** icon on the desktop or in the Start menu.
- Choose **Images** or **Video** at the top. The small **i** buttons explain each control.
- Everything you make is saved in the **outputs** folder. The app has a button that opens it.
- The **power button** in the app closes it. Closing only the browser leaves the app running in the background.
- More detail: [READ ME.txt](READ%20ME.txt) (pictures) and [VIDEO - START HERE.txt](VIDEO%20-%20START%20HERE.txt) (video and movies).

## What your PC needs

| | Recommended | Notes |
|---|---|---|
| Graphics card | **16 GB** of video memory | The settings were tuned on an AMD Radeon RX 9070 XT (16 GB). AMD, NVIDIA and Intel Arc cards work through Vulkan, so keep the graphics driver up to date. With 8 to 12 GB, pictures should work but video may fail or be very slow. |
| Memory (RAM) | 32 GB | |
| Disk space | 90 GB free | 72 GB of models, 1 GB of programs, plus room for your videos. Video stops when less than 5 GB is free. |
| Windows | 10 or 11, 64-bit | |

The installer checks the graphics card, memory and disk space, and tells you if anything is short.

**Tip:** web browsers also use video memory. During long video runs, close games, video players
and other browser tabs. Leave only the Local Image Lab tab open.

## How long things take

Measured on the RX 9070 XT (16 GB). Other cards will be different.

| Job | Time |
|---|---|
| Picture, Qwen Image Turbo, 1024 x 1024 | about 25 seconds |
| Picture, FLUX 3 Klein, 512 x 512 | about 10 seconds |
| Installation test video (Quick size, 2.3 s) | about 8 minutes |
| Video clip, Quick size 512 x 288, 14.4 s | about 30 minutes |
| Video clip, Standard size 768 x 448, 5.2 s | about 45 to 50 minutes |

Video slows down sharply once a clip is larger than about **52 million frame-pixels**
(width x height x number of frames). Past that, a single clip can take hours. Large size
(1024 x 576) and long Standard clips are over the limit. Guided movies keep their scenes under it
automatically. **Quick size** is the practical choice for long movies. A 12-scene movie takes many
hours, so leave it running overnight. The app keeps the PC awake while it works.

## What the installer downloads

Everything comes from its official source, pinned to an exact version and checked against
its SHA-256 hash. The pinned list is in [installer/runtimes.json](installer/runtimes.json),
[model-downloads.json](model-downloads.json) and the `video-*-downloads.json` files.

| Item | Download | Source | Licence |
|---|---|---|---|
| Node.js 24.19.0 | 37 MB | nodejs.org | MIT |
| stable-diffusion.cpp master-970-2f016e8 (Vulkan) | 30 MB | github.com/leejet/stable-diffusion.cpp | MIT |
| llama.cpp b11669 (Vulkan) | 32 MB | github.com/ggml-org/llama.cpp | MIT |
| FFmpeg 9.0.2 full build (gyan.dev) | 258 MB | github.com/GyanD/codexffmpeg | GPL-3.0 |
| Ollama 0.33.3 (only the Vulkan parts are kept, about 130 MB) | 1.5 GB | github.com/ollama/ollama | MIT |
| Qwen Image 2.1 Turbo + its VAE | 4.9 GB | Hugging Face: AtomicChat, Comfy-Org | Qwen Research Licence (non-commercial) |
| Qwen Image text encoder ("Uncensored" Qwen3-VL 8B) + vision part | 6.4 GB | Hugging Face: AtomicChat | Apache-2.0 |
| FLUX 3 Image Klein Q4_K_M + its VAE | 4.0 GB | Hugging Face: unsloth, Comfy-Org | FLUX Kommunity Licence (non-commercial) |
| Qwen3-VL 4B Instruct + vision part (FLUX encoder, prompt helper, Guided scene reader) | 3.3 GB | Hugging Face: Qwen | Apache-2.0 |
| MiniMax H3 video model, Qwen3-VL 32B encoder, video and audio decoders | 35.5 GB | Hugging Face: leejet, Comfy-Org | MiniMax H3 Community Licence |
| MiniMax H3 reference model (Ref2VA) | 11.4 GB | Hugging Face: leejet | MiniMax H3 Community Licence |
| Qwen3.5 9B story writer | 6.6 GB | Ollama library (qwen3.5:9b) | Apache-2.0 |
| MiniMax H3 Turbo LoRA (optional fast mode, 8 or 6 steps) | 780 MB | Hugging Face: larryvrh | Apache-2.0 |
| 4xNomos2 photo upscaler | 17 MB | github.com/Phhofm/models | CC-BY-4.0 |

**Total:** about 72 GB of models and 1.8 GB of programs.

**Licences:** the models are free for personal use, but several are not licensed for
commercial use (Qwen Image, FLUX). The MiniMax H3 Community Licence does not grant rights in
the European Union, the United Kingdom, South Korea or the United States. Read the licences in
[licenses](licenses) and on each model's page before using what you make for anything beyond
personal use. No model files are stored in this repository.

## If something goes wrong

- **The installer stopped:** read the message in red, then double-click **Install.cmd** again.
  Finished downloads are kept. A full log is in `logs\install.log`.
- **Not enough disk space:** move the whole folder to a drive with more free space, then run **Install.cmd** again.
- **The app does not open:** double-click **Start (console fallback).cmd** to see the error.
- **"Ran out of memory":** use a smaller size, fewer reference pictures, or close other programs and browser tabs.
- **The Video page says a download is incomplete:** click **Resume download** there, or run **Install.cmd** again.

## Known issues

- **Only tested on one PC** (Radeon RX 9070 XT with 16 GB). Pictures adapt to the graphics card
  automatically. Video uses a fixed 12.5 GB memory budget, so on cards under 16 GB video may run
  out of memory. The ~52 million frame-pixel speed limit was also measured on that card.
- **Installer test coverage:** all download links were checked. A fresh test install downloaded
  all five programs (byte-identical to the original PC) and some of the models. The remaining
  models were checked against their SHA-256 hashes from an existing copy. They were not all
  downloaded from scratch.
- **Ollama download is larger than needed:** the official package is 1.5 GB because it includes
  NVIDIA CUDA files. The installer keeps only the ~130 MB Vulkan part and deletes the rest.
- **First-run test videos** use the graphics card for about 25 minutes. Pictures can't be made
  while they run. Cancel them on the Video page if needed.
- **A damaged model file** stops the installer with *"Unexpected existing target hash"*. Delete
  the file it names (in the `models` folder) and run **Install.cmd** again.
- Windows may warn before running **Install.cmd**, because the scripts are not digitally signed.

## Updating

Download the new ZIP and extract it. Copy everything into your existing Local Image Lab folder,
choosing **Replace**. Your models, programs, pictures and videos stay. Then run **Install.cmd**
once, which only fetches anything new.

## Removing it

Delete the Local Image Lab folder, plus the **Local Image Lab** shortcuts on the desktop and in
the Start menu. Nothing else was installed.

## What is in this repository

| Path | Contents |
|---|---|
| `Install.cmd`, `installer/` | One-click installer. It is safe to run again to resume or repair. |
| `Start Local Image Lab.vbs` | Starts the app with no console window. The desktop shortcut points here. |
| `Start (console fallback).cmd` | Starts the app with a visible console that shows errors. |
| `app/` | The local server (Node.js) and the web interface. It only answers on `127.0.0.1:48766`, so only this PC can use it. |
| `*-downloads.json` | Pinned model sources, sizes and SHA-256 hashes. |
| `models/story-writer/ollama/` | Small package files for the story writer. The 6.6 GB model itself is downloaded. |
| `licenses/` | Licence texts for the bundled notices and models. |

Folders the app creates while running (`runtime/`, `models/`, `outputs/`, `inputs/`, `logs/`)
are not part of the repository.
