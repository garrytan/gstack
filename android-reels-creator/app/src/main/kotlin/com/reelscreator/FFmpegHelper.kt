package com.reelscreator

import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.ReturnCode

object FFmpegHelper {

    fun trimVideo(input: String, output: String, startSec: Double, durationSec: Double, onDone: (Boolean) -> Unit) {
        val cmd = "-y -ss $startSec -t $durationSec -i \"$input\" -c copy \"$output\""
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun mergeClips(inputs: List<String>, output: String, onDone: (Boolean) -> Unit) {
        val listFile = output.replace(".mp4", "_list.txt")
        java.io.File(listFile).writeText(inputs.joinToString("\n") { "file '$it'" })
        val cmd = "-y -f concat -safe 0 -i \"$listFile\" -c copy \"$output\""
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun addAudio(videoInput: String, audioInput: String, output: String, onDone: (Boolean) -> Unit) {
        val cmd = "-y -i \"$videoInput\" -i \"$audioInput\" " +
                "-map 0:v -map 1:a -c:v copy -shortest \"$output\""
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun resizeToReels(input: String, output: String, onDone: (Boolean) -> Unit) {
        val cmd = "-y -i \"$input\" " +
                "-vf \"scale=1080:1920:force_original_aspect_ratio=decrease," +
                "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black\" " +
                "-c:a copy \"$output\""
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
        val safe = text.replace("'", "\\'").replace(":", "\\:")
        val cmd = "-y -i \"$input\" " +
                "-vf \"drawtext=fontfile='$fontPath':text='$safe':" +
                "fontcolor=$color:fontsize=$fontSize:x=$x:y=$y:" +
                "box=1:boxcolor=black@0.4:boxborderw=8\" " +
                "-codec:a copy \"$output\""
        FFmpegKit.executeAsync(cmd) { session ->
            onDone(ReturnCode.isSuccess(session.returnCode))
        }
    }

    fun textToVideo(
        lines: List<String>, output: String,
        fontPath: String, bgColor: String = "black",
        onDone: (Boolean) -> Unit
    ) {
        val segments = lines.mapIndexed { i, line ->
            val safe = line.replace("'", "\\'").replace(":", "\\:")
            "color=c=$bgColor:s=1080x1920:d=3[bg$i];" +
                    "[bg$i]drawtext=fontfile='$fontPath':text='$safe':" +
                    "fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2[v$i]"
        }
        val concatInputs = lines.indices.joinToString("") { "[v$it]" }
        val filter = segments.joinToString(";") + ";${concatInputs}concat=n=${lines.size}:v=1:a=0[out]"
        val cmd = "-y -filter_complex \"$filter\" -map \"[out]\" -r 30 \"$output\""
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
