package com.reelscreator

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class ReelsState(
    val isProcessing: Boolean = false,
    val progress: Double = 0.0,
    val outputPath: String? = null,
    val error: String? = null
)

class ReelsViewModel : ViewModel() {
    private val _state = MutableStateFlow(ReelsState())
    val state: StateFlow<ReelsState> = _state.asStateFlow()

    private fun processing() = _state.value.copy(isProcessing = true, error = null, outputPath = null)
    private fun done(path: String) = _state.value.copy(isProcessing = false, outputPath = path, progress = 0.0)
    private fun failed(msg: String) = _state.value.copy(isProcessing = false, error = msg, progress = 0.0)

    fun clearResult() {
        _state.value = _state.value.copy(outputPath = null, error = null)
    }

    fun trimVideo(input: String, output: String, start: Double, duration: Double) {
        _state.value = processing()
        FFmpegHelper.trimVideo(input, output, start, duration) { ok ->
            _state.value = if (ok) done(output) else failed("Trim failed")
        }
    }

    fun mergeClips(inputs: List<String>, output: String) {
        _state.value = processing()
        FFmpegHelper.mergeClips(inputs, output) { ok ->
            _state.value = if (ok) done(output) else failed("Merge failed")
        }
    }

    fun addAudio(video: String, audio: String, output: String) {
        _state.value = processing()
        FFmpegHelper.addAudio(video, audio, output) { ok ->
            _state.value = if (ok) done(output) else failed("Audio mix failed")
        }
    }

    fun resizeToReels(input: String, output: String) {
        _state.value = processing()
        FFmpegHelper.resizeToReels(input, output) { ok ->
            _state.value = if (ok) done(output) else failed("Resize failed")
        }
    }

    fun addCaption(input: String, output: String, text: String, fontPath: String) {
        _state.value = processing()
        FFmpegHelper.addTextOverlay(input, output, text, fontPath) { ok ->
            _state.value = if (ok) done(output) else failed("Caption failed")
        }
    }

    fun textToVideo(lines: List<String>, output: String, fontPath: String) {
        _state.value = processing()
        FFmpegHelper.textToVideo(lines, output, fontPath) { ok ->
            _state.value = if (ok) done(output) else failed("Text-to-video failed")
        }
    }

    fun addTxtOverlay(video: String, txtPath: String, output: String, fontPath: String, durationSec: Double) {
        _state.value = processing()
        FFmpegHelper.addTxtOverlay(video, output, txtPath, fontPath, durationSec) { ok ->
            _state.value = if (ok) done(output) else failed("TXT overlay failed")
        }
    }

    fun executeWithProgress(cmd: String) {
        _state.value = processing()
        FFmpegHelper.executeWithProgress(
            cmd,
            onProgress = { time -> _state.value = _state.value.copy(progress = time) },
            onDone = { ok -> _state.value = if (ok) done("") else failed("Operation failed") }
        )
    }
}
