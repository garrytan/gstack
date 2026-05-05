package com.reelscreator

import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.ReturnCode

object FFmpegHelper {

    // Escapes text for use inside an FFmpeg drawtext filter value.
    // Order matters: backslash must be first.
    private fun escapeDrawtext(text: String): String = text
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace("%", "\\%")
        .replace("\n", " ")

    // Escapes a file path for use inside a single-quoted FFmpeg argument.
    private fun escapePath(path: String): String = path
        .replace("\\", "\\\\")
        .replace("'", "\\'")

    fun trimVideo(input: String, output: String, startSec: Double, durationSec: Double, onDone: (Boolean) -> Unit) {
        val cmd = "-y -ss $startSec -t $durationSec -i '${escapePath(input)}' -c copy '${escapePath(output)}'"
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun mergeClips(inputs: List<String>, output: String, onDone: (Boolean) -> Unit) {
        val listFile = output.replace(".mp4", "_list.txt")
        java.io.File(listFile).writeText(inputs.joinToString("\n") { "file '${escapePath(it)}'" })
        val cmd = "-y -f concat -safe 0 -i '${escapePath(listFile)}' -c copy '${escapePath(output)}'"
        FFmpegKit.executeAsync(cmd) { session ->
            java.io.File(listFile).delete()
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun addAudio(videoInput: String, audioInput: String, output: String, onDone: (Boolean) -> Unit) {
        val cmd = "-y -i '${escapePath(videoInput)}' -i '${escapePath(audioInput)}' " +
                "-map 0:v -map 1:a -c:v copy -shortest '${escapePath(output)}'"
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun resizeToReels(input: String, output: String, onDone: (Boolean) -> Unit) {
        val cmd = "-y -i '${escapePath(input)}' " +
                "-vf 'scale=1080:1920:force_original_aspect_ratio=decrease," +
                "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black' " +
                "-c:a copy '${escapePath(output)}'"
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun addTextOverlay(
        input: String, output: String,
        text: String, fontPath: String,
        x: String = "(w-text_w)/2", y: String = "h-100",
        fontSize: Int = 48, color: String = "white",
        onDone: (Boolean) -> Unit
    ) {
        val safe = escapeDrawtext(text)
        val cmd = "-y -i '${escapePath(input)}' " +
                "-vf \"drawtext=fontfile='${escapePath(fontPath)}':text='$safe':" +
                "fontcolor=$color:fontsize=$fontSize:x=$x:y=$y:" +
                "box=1:boxcolor=black@0.4:boxborderw=8\" " +
                "-codec:a copy '${escapePath(output)}'"
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun textToVideo(
        lines: List<String>, output: String,
        fontPath: String, bgColor: String = "black",
        onDone: (Boolean) -> Unit
    ) {
        val fp = escapePath(fontPath)
        val segments = lines.mapIndexed { i, line ->
            val safe = escapeDrawtext(line)
            "color=c=$bgColor:s=1080x1920:d=3[bg$i];" +
                    "[bg$i]drawtext=fontfile='$fp':text='$safe':" +
                    "fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2[v$i]"
        }
        val concatInputs = lines.indices.joinToString("") { "[v$it]" }
        val filter = segments.joinToString(";") + ";${concatInputs}concat=n=${lines.size}:v=1:a=0[out]"
        val cmd = "-y -filter_complex \"$filter\" -map \"[out]\" -r 30 '${escapePath(output)}'"
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    // Accepts pre-read lines so callers control the IO dispatcher.
    fun addTxtOverlay(
        input: String, output: String,
        lines: List<String>, fontPath: String,
        videoDurationSec: Double,
        fontSize: Int = 48, color: String = "white",
        onDone: (Boolean) -> Unit
    ) {
        if (lines.isEmpty()) { onDone(false); return }

        val fp = escapePath(fontPath)
        val sliceDur = videoDurationSec / lines.size
        val drawFilters = lines.mapIndexed { i, line ->
            val safe = escapeDrawtext(line.trim())
            val start = "%.3f".format(i * sliceDur)
            val end   = "%.3f".format((i + 1) * sliceDur)
            "drawtext=fontfile='$fp':text='$safe':" +
            "fontcolor=$color:fontsize=$fontSize:" +
            "x=(w-text_w)/2:y=h-120:" +
            "box=1:boxcolor=black@0.5:boxborderw=10:" +
            "enable='between(t\\,$start\\,$end)'"
        }
        val vf = drawFilters.joinToString(",")
        val cmd = "-y -i '${escapePath(input)}' -vf \"$vf\" -codec:a copy '${escapePath(output)}'"
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun executeWithProgress(
        cmd: String,
        onProgress: (Double) -> Unit,
        onDone: (Boolean) -> Unit
    ) {
        FFmpegKit.executeAsync(cmd,
            { session -> onDone(ReturnCode.isSuccess(session.returnCode)) },
            { _ -> },
            { stats -> onProgress(stats.time / 1000.0) }
        )
    }
}
