package com.reelscreator

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

// ── Shared composables ────────────────────────────────────────────────────────

@Composable
private fun FilePicker(
    label: String,
    uri: Uri?,
    mimeType: String = "video/*",
    onPicked: (Uri) -> Unit
) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { u ->
        if (u != null) onPicked(u)
    }
    OutlinedButton(
        onClick = { launcher.launch(mimeType) },
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(if (uri != null) uri.lastPathSegment ?: label else label)
    }
}

@Composable
private fun ProcessButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth()
    ) { Text(label) }
}

private fun Uri.toPath(context: android.content.Context): String? {
    return RealPathUtil.getPath(context, this)
}

// ── Trim Tab ──────────────────────────────────────────────────────────────────

@Composable
fun TrimTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    var videoUri by remember { mutableStateOf<Uri?>(null) }
    var startSec by remember { mutableStateOf("0") }
    var durationSec by remember { mutableStateOf("15") }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Trim a video clip", style = MaterialTheme.typography.titleMedium)
        FilePicker("Pick video", videoUri) { videoUri = it }

        OutlinedTextField(
            value = startSec,
            onValueChange = { startSec = it },
            label = { Text("Start (seconds)") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = durationSec,
            onValueChange = { durationSec = it },
            label = { Text("Duration (seconds)") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth()
        )

        ProcessButton(
            label = "Trim",
            enabled = videoUri != null
        ) {
            val path = videoUri!!.toPath(context) ?: return@ProcessButton
            val output = getOutputPath(context, "trim_${System.currentTimeMillis()}.mp4")
            vm.trimVideo(path, output, startSec.toDoubleOrNull() ?: 0.0, durationSec.toDoubleOrNull() ?: 15.0)
        }
    }
}

// ── Merge Tab ─────────────────────────────────────────────────────────────────

@Composable
fun MergeTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    var clips by remember { mutableStateOf(listOf<Uri>()) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { u ->
        if (u != null) clips = clips + u
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Merge video clips", style = MaterialTheme.typography.titleMedium)

        clips.forEachIndexed { i, uri ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "${i + 1}. ${uri.lastPathSegment ?: "clip"}",
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall
                )
                IconButton(onClick = { clips = clips.toMutableList().also { it.removeAt(i) } }) {
                    Icon(Icons.Default.Delete, contentDescription = "Remove")
                }
            }
        }

        OutlinedButton(
            onClick = { launcher.launch("video/*") },
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Default.Add, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Add clip")
        }

        ProcessButton(
            label = "Merge ${clips.size} clips",
            enabled = clips.size >= 2
        ) {
            val paths = clips.mapNotNull { it.toPath(context) }
            if (paths.size < 2) return@ProcessButton
            val output = getOutputPath(context, "merge_${System.currentTimeMillis()}.mp4")
            vm.mergeClips(paths, output)
        }
    }
}

// ── Audio Tab ─────────────────────────────────────────────────────────────────

@Composable
fun AudioTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    var videoUri by remember { mutableStateOf<Uri?>(null) }
    var audioUri by remember { mutableStateOf<Uri?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Add background music", style = MaterialTheme.typography.titleMedium)
        FilePicker("Pick video", videoUri) { videoUri = it }
        FilePicker("Pick audio", audioUri, mimeType = "audio/*") { audioUri = it }

        ProcessButton(
            label = "Mix audio",
            enabled = videoUri != null && audioUri != null
        ) {
            val vPath = videoUri!!.toPath(context) ?: return@ProcessButton
            val aPath = audioUri!!.toPath(context) ?: return@ProcessButton
            val output = getOutputPath(context, "audio_${System.currentTimeMillis()}.mp4")
            vm.addAudio(vPath, aPath, output)
        }
    }
}

// ── Resize Tab ────────────────────────────────────────────────────────────────

@Composable
fun ResizeTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    var videoUri by remember { mutableStateOf<Uri?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Resize to 9:16 Reels format (1080×1920)", style = MaterialTheme.typography.titleMedium)
        FilePicker("Pick video", videoUri) { videoUri = it }

        ProcessButton(
            label = "Resize to Reels",
            enabled = videoUri != null
        ) {
            val path = videoUri!!.toPath(context) ?: return@ProcessButton
            val output = getOutputPath(context, "reels_${System.currentTimeMillis()}.mp4")
            vm.resizeToReels(path, output)
        }
    }
}

// ── Caption Tab ───────────────────────────────────────────────────────────────

@Composable
fun CaptionTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    var videoUri by remember { mutableStateOf<Uri?>(null) }
    var captionText by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Burn-in caption", style = MaterialTheme.typography.titleMedium)
        FilePicker("Pick video", videoUri) { videoUri = it }

        OutlinedTextField(
            value = captionText,
            onValueChange = { captionText = it },
            label = { Text("Caption text") },
            placeholder = { Text("Enter caption...") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2
        )

        ProcessButton(
            label = "Add caption",
            enabled = videoUri != null && captionText.isNotBlank()
        ) {
            val path = videoUri!!.toPath(context) ?: return@ProcessButton
            val output = getOutputPath(context, "caption_${System.currentTimeMillis()}.mp4")
            val fontPath = getFontPath(context)
            vm.addCaption(path, output, captionText, fontPath)
        }
    }
}

// ── Text-to-Video Tab ─────────────────────────────────────────────────────────

@Composable
fun TextToVideoTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    var rawText by remember { mutableStateOf("") }

    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.verticalScroll(rememberScrollState())
    ) {
        Text("Text → Video slides", style = MaterialTheme.typography.titleMedium)
        Text(
            "Each line becomes a 3-second slide (1080×1920, black background).",
            style = MaterialTheme.typography.bodySmall
        )

        OutlinedTextField(
            value = rawText,
            onValueChange = { rawText = it },
            label = { Text("Lines (one per slide)") },
            placeholder = { Text("Line 1\nLine 2\nLine 3") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 5
        )

        val lines = rawText.lines().filter { it.isNotBlank() }
        Text("${lines.size} slide(s) = ~${lines.size * 3}s", style = MaterialTheme.typography.bodySmall)

        ProcessButton(
            label = "Generate video",
            enabled = lines.isNotEmpty()
        ) {
            val output = getOutputPath(context, "text2video_${System.currentTimeMillis()}.mp4")
            val fontPath = getFontPath(context)
            vm.textToVideo(lines, output, fontPath)
        }
    }
}
