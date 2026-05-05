package com.reelscreator

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ReelsState(
    val isProcessing: Boolean = false,
    val progress: Double = 0.0,
    val outputPath: String? = null,
    val error: String? = null
)

data class NewsState(
    val isLoading: Boolean = false,
    val items: List<NewsItem> = emptyList(),
    val error: String? = null,
    val sourceName: String = ""
)

class ReelsViewModel : ViewModel() {

    private val _state = MutableStateFlow(ReelsState())
    val state: StateFlow<ReelsState> = _state.asStateFlow()

    private val _newsState = MutableStateFlow(NewsState())
    val newsState: StateFlow<NewsState> = _newsState.asStateFlow()

    // ── Processing state helpers ──────────────────────────────────────────

    private fun processing() = _state.value.copy(isProcessing = true, error = null, outputPath = null)
    private fun done(path: String?) = _state.value.copy(isProcessing = false, outputPath = path, progress = 0.0)
    private fun failed(msg: String) = _state.value.copy(isProcessing = false, error = msg, progress = 0.0)

    private fun guardBusy(): Boolean {
        if (_state.value.isProcessing) return true
        return false
    }

    fun clearResult() {
        _state.value = _state.value.copy(outputPath = null, error = null)
    }

    // ── News feed ─────────────────────────────────────────────────────────

    fun fetchNews(url: String, sourceName: String) {
        viewModelScope.launch {
            _newsState.value = NewsState(isLoading = true, sourceName = sourceName)
            RssRepository.fetch(url)
                .onSuccess { items ->
                    _newsState.value = NewsState(items = items, sourceName = sourceName)
                }
                .onFailure { e ->
                    _newsState.value = NewsState(
                        error = e.message ?: "Network error — check your connection",
                        sourceName = sourceName
                    )
                }
        }
    }

    // ── Video operations ──────────────────────────────────────────────────

    fun trimVideo(input: String, output: String, start: Double, duration: Double) {
        if (guardBusy()) return
        _state.value = processing()
        FFmpegHelper.trimVideo(input, output, start, duration) { ok ->
            _state.value = if (ok) done(output) else failed("Trim failed")
        }
    }

    fun mergeClips(inputs: List<String>, output: String) {
        if (guardBusy()) return
        _state.value = processing()
        FFmpegHelper.mergeClips(inputs, output) { ok ->
            _state.value = if (ok) done(output) else failed("Merge failed")
        }
    }

    fun addAudio(video: String, audio: String, output: String) {
        if (guardBusy()) return
        _state.value = processing()
        FFmpegHelper.addAudio(video, audio, output) { ok ->
            _state.value = if (ok) done(output) else failed("Audio mix failed")
        }
    }

    fun resizeToReels(input: String, output: String) {
        if (guardBusy()) return
        _state.value = processing()
        FFmpegHelper.resizeToReels(input, output) { ok ->
            _state.value = if (ok) done(output) else failed("Resize failed")
        }
    }

    fun addCaption(input: String, output: String, text: String, fontPath: String) {
        if (guardBusy()) return
        _state.value = processing()
        FFmpegHelper.addTextOverlay(input, output, text, fontPath) { ok ->
            _state.value = if (ok) done(output) else failed("Caption failed")
        }
    }

    fun textToVideo(lines: List<String>, output: String, fontPath: String) {
        if (guardBusy()) return
        _state.value = processing()
        FFmpegHelper.textToVideo(lines, output, fontPath) { ok ->
            _state.value = if (ok) done(output) else failed("Text-to-video failed")
        }
    }

    fun addTxtOverlay(video: String, txtPath: String, output: String, fontPath: String, durationSec: Double) {
        if (guardBusy()) return
        _state.value = processing()
        viewModelScope.launch {
            val lines = withContext(Dispatchers.IO) {
                runCatching { java.io.File(txtPath).readLines().filter { it.isNotBlank() } }
                    .getOrElse { emptyList() }
            }
            if (lines.isEmpty()) {
                _state.value = failed("TXT file empty or unreadable")
                return@launch
            }
            FFmpegHelper.addTxtOverlay(video, output, lines, fontPath, durationSec) { ok ->
                _state.value = if (ok) done(output) else failed("TXT overlay failed")
            }
        }
    }

    fun executeWithProgress(cmd: String) {
        if (guardBusy()) return
        _state.value = processing()
        FFmpegHelper.executeWithProgress(
            cmd,
            onProgress = { time -> _state.value = _state.value.copy(progress = time) },
            onDone = { ok -> _state.value = if (ok) done(null) else failed("Operation failed") }
        )
    }
}
