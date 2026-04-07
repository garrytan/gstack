---
name: jank-removal
description: Mobile performance tuning — identify and fix jank, dropped frames, memory issues, slow startups, and battery drain in Flutter, Swift, and Kotlin apps.
---

# /jank-removal

Run this when users report slow, stuttering, or unresponsive behavior. This skill helps diagnose and fix performance issues that degrade the user experience.

## Use when

- UI stuttering, dropped frames, or inconsistent frame times.
- Slow app startup (cold or warm).
- High memory usage, memory leaks, or OOM crashes.
- Battery drain from excessive background activity or animations.
- Slow list scrolling or rendering of large datasets.
- Profile-guided optimization needs.
- Post-launch performance regression detected.

## Inputs

Collect or infer:

- Platform: `flutter`, `swift`, `kotlin`, or `expo`.
- Target OS: iOS, Android, or both.
- What changed: diff, PR, or feature that introduced the issue.
- Symptoms: startup time, FPS during specific actions, memory over time.
- Profiling data: if available (perfetto, instruments, Flutter DevTools, systrace).
- Device targeting: specific devices or OS versions affected.

If platform is missing:
- Read `~/.gstack/config` or project docs.
- If still unclear, ask one concise question before proceeding.

## Review standard

### 1. Frame timing and jank
- Target 60fps (or 120fps on ProMotion/high-refresh), identify frames exceeding 16ms (or 8ms).
- Check for unnecessary rebuilds (Flutter: setState in build, excessive const removal).
- Verify repaint boundary usage where appropriate.
- Identify layout thrashing (multiple passes to resolve size/position).
- Check for heavy compositing (shadows, blurs, clipRRect in loops).

### 2. Startup performance
- Measure cold startup (no process), warm startup (process alive), hot restart (Dart VM warm).
- Identify main isolate blocking work during startup.
- Lazy-load non-critical initialization.
- Optimize app icon and splash (or remove custom splash entirely).
- A/B test any pre-warming or predictive initialization.

### 3. Memory management
- Track memory growth over time (leaks).
- Identify retained objects not being released (listeners, callbacks, streams).
- Use image caching with size limits.
- Implement pagination for large lists.
- Dispose controllers, streams, and subscriptions in Flutter.
- Check for retain cycles in Swift/Kotlin (weak references, proper deinit).

### 4. List and scroll performance
- Use lazy loading (ListView.builder, RecyclerView, UICollectionView).
- Implement item extent estimation.
- Avoid layout during scroll (pre-cache off-screen items moderately).
- Use stable keys in Flutter to preserve widget state.
- Check image loading and decoding on background thread.

### 5. Animation performance
- Use dedicated animation drivers (AnimationController, CADisplayLink, ValueAnimator).
- Avoid layout changes during animation.
- Use transform/opacity for cheap animations, not repaint-heavy properties.
- Check for over-animation (animations firing unnecessarily).
- Respect reduced motion accessibility setting.

### 6. Battery and background
- Minimize wake locks, GPS, or network in background.
- Use background fetch sparingly or rely on push notifications.
- Check for unnecessary background refresh.
- Use efficient network batching (fewer requests, larger payloads).
- Defer non-critical work until device is charging.

### 7. Profiling and tools
- iOS: Time Profiler, Allocations, Core Animation FPS meter.
- Android: Perfetto, Android Profiler, systrace.
- Flutter: DevTools timeline, performance view, memory view.
- Benchmark with release build (debug has extra overhead).

## Output format

Use this exact structure:

### Verdict
One paragraph with a blunt recommendation:
- `PASS`
- `PASS WITH WARNINGS`
- `FAIL`

### Critical issues
Bullets only. Include only issues causing user-visible problems.

### Warnings
Bullets only. Important but non-blocking.

### Platform-specific notes
Split into:
- `iOS`
- `Android`
- `Flutter / shared`
Only include sections that apply.

### Recommended fix
Give the most opinionated path to fix the issue.

### Build checklist
Provide a short, execution-ready checklist.

## Style

- Be direct and specific.
- Prefer measurement over guesswork.
- Don't optimize prematurely — fix user-visible problems first.
- Flag issues that will get worse at scale (more data, more users).
- Consider battery impact as a first-class concern.

## Mobile-specific checks

- Release build performance (debug is not representative).
- Test on low-end devices, not just flagship.
- Frame rate in sustained use, not just initial interaction.
- Memory under typical usage patterns, not just fresh launch.

## Examples

Good prompts:
- `/jank-removal fix the scrolling jank in this list`
- `/jank-removal improve cold startup time for this Flutter app`
- `/jank-removal diagnose high memory usage after extended use`

Bad prompts:
- `/jank-removal make it faster`
- `/jank-removal optimize performance`