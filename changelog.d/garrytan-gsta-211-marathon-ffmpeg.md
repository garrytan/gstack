**The weekly marathon evals can run /design-motion again: the CI eval image now ships ffmpeg (#3687).** The `design-motion-showcase` case joined the marathon tier on 2026-10-26, and its first scheduled run (Actions run 41200316994, main @ 088bfc5) failed 0/3. Every trial built and captured the page, then stopped at `FFMPEG_MISSING`, because the image had no ffmpeg and the skill rightly refuses to export before its checks run. The model did nothing wrong; the case could not pass on that image.

### Fixed
- **`.github/docker/Dockerfile.ci`** installs Ubuntu's `ffmpeg` (6.1.1, with `ffprobe`). The build fails if that ffmpeg lacks a filter or encoder the motion checks and exports use (`psnr`, `gblur`, `palettegen`, `paletteuse`, `signalstats`, `tile`, `libx264`, `gif`).
- **`test/ci-image-cli-pin.test.ts`** fails the free suite if the image stops installing ffmpeg or stops checking it.
