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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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

// Always copy via ContentResolver so Media3 Transformer gets a real path on all API levels.
private fun Uri.toPath(context: android.content.Context, suffix: String = ".mp4"): String? =
    copyToCacheFile(context, suffix)

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
            val vPath = videoUri!!.toPath(context, ".mp4") ?: return@ProcessButton
            val aPath = audioUri!!.toPath(context, ".mp3") ?: return@ProcessButton
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
            vm.addCaption(path, output, captionText)
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
            vm.textToVideo(lines, output)
        }
    }
}

// ── TXT File Overlay Tab ──────────────────────────────────────────────────────

@Composable
fun TxtOverlayTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    var videoUri by remember { mutableStateOf<Uri?>(null) }
    var txtUri by remember { mutableStateOf<Uri?>(null) }
    var durationSec by remember { mutableStateOf("30") }
    var previewLines by remember { mutableStateOf<List<String>>(emptyList()) }

    val txtLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { u ->
        if (u != null) {
            txtUri = u
            previewLines = try {
                context.contentResolver.openInputStream(u)
                    ?.bufferedReader()?.readLines()
                    ?.filter { it.isNotBlank() }
                    ?: emptyList()
            } catch (_: Exception) { emptyList() }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("TXT file → timed captions on video", style = MaterialTheme.typography.titleMedium)
        Text(
            "Each line of the .txt file is shown as a caption for an equal slice of the video duration.",
            style = MaterialTheme.typography.bodySmall
        )

        FilePicker("Pick video", videoUri) { videoUri = it }

        OutlinedButton(
            onClick = { txtLauncher.launch("text/plain") },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(if (txtUri != null) txtUri!!.lastPathSegment ?: "txt file selected" else "Pick .txt file")
        }

        if (previewLines.isNotEmpty()) {
            Text("${previewLines.size} lines found:", style = MaterialTheme.typography.labelMedium)
            previewLines.take(5).forEach { line ->
                Text(
                    "• $line",
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic,
                    modifier = Modifier.padding(start = 8.dp)
                )
            }
            if (previewLines.size > 5) {
                Text("… and ${previewLines.size - 5} more", style = MaterialTheme.typography.bodySmall)
            }
        }

        OutlinedTextField(
            value = durationSec,
            onValueChange = { durationSec = it },
            label = { Text("Video duration (seconds)") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth()
        )

        if (previewLines.isNotEmpty()) {
            val dur = durationSec.toDoubleOrNull() ?: 0.0
            val slice = if (previewLines.isNotEmpty() && dur > 0) dur / previewLines.size else 0.0
            Text(
                "Each caption shown for ~${"%.1f".format(slice)}s",
                style = MaterialTheme.typography.bodySmall
            )
        }

        ProcessButton(
            label = "Burn captions",
            enabled = videoUri != null && txtUri != null && previewLines.isNotEmpty()
        ) {
            val vPath = videoUri!!.toPath(context) ?: return@ProcessButton
            val dur = durationSec.toDoubleOrNull() ?: 30.0

            // Copy txt to a temp file FFmpeg can read
            val tmpTxt = java.io.File(context.cacheDir, "overlay_${System.currentTimeMillis()}.txt")
            context.contentResolver.openInputStream(txtUri!!)?.use { input ->
                tmpTxt.outputStream().use { input.copyTo(it) }
            }

            val output = getOutputPath(context, "txt_overlay_${System.currentTimeMillis()}.mp4")
            vm.addTxtOverlay(vPath, tmpTxt.absolutePath, output, dur)
        }
    }
}

// ── News Feed Tab ─────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewsFeedTab(vm: ReelsViewModel) {
    val context = LocalContext.current
    val newsState by vm.newsState.collectAsState()
    var selectedSource by remember { mutableStateOf(RssRepository.feeds.keys.first()) }
    var dropdownExpanded by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<Int>()) }

    // Reset selection when feed changes
    LaunchedEffect(newsState.sourceName) { selected = emptySet() }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {

        Text("News → Reels", style = MaterialTheme.typography.titleMedium)
        Text(
            "Fetch today's headlines and generate a video reel instantly.",
            style = MaterialTheme.typography.bodySmall
        )

        // Source picker
        ExposedDropdownMenuBox(
            expanded = dropdownExpanded,
            onExpandedChange = { dropdownExpanded = it }
        ) {
            OutlinedTextField(
                value = selectedSource,
                onValueChange = {},
                readOnly = true,
                label = { Text("News source") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(dropdownExpanded) },
                modifier = Modifier
                    .fillMaxWidth()
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable)
            )
            ExposedDropdownMenu(
                expanded = dropdownExpanded,
                onDismissRequest = { dropdownExpanded = false }
            ) {
                RssRepository.feeds.keys.forEach { name ->
                    DropdownMenuItem(
                        text = { Text(name) },
                        onClick = { selectedSource = name; dropdownExpanded = false }
                    )
                }
            }
        }

        Button(
            onClick = {
                val url = RssRepository.feeds[selectedSource] ?: return@Button
                vm.fetchNews(url, selectedSource)
            },
            modifier = Modifier.fillMaxWidth(),
            enabled = !newsState.isLoading
        ) {
            if (newsState.isLoading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary
                )
                Spacer(Modifier.width(8.dp))
                Text("Fetching…")
            } else {
                Icon(Icons.Default.Refresh, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Fetch headlines")
            }
        }

        newsState.error?.let { err ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Text(
                    err,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(12.dp)
                )
            }
        }

        if (newsState.items.isNotEmpty()) {
            // Select all / deselect all
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "${newsState.items.size} headlines · ${selected.size} selected",
                    style = MaterialTheme.typography.labelMedium
                )
                TextButton(onClick = {
                    selected = if (selected.size == newsState.items.size) emptySet()
                    else newsState.items.indices.toSet()
                }) {
                    Text(if (selected.size == newsState.items.size) "Deselect all" else "Select all")
                }
            }

            // Headline cards
            newsState.items.forEachIndexed { i, item ->
                val isSelected = i in selected
                Card(
                    onClick = {
                        selected = if (isSelected) selected - i else selected + i
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = if (isSelected)
                            MaterialTheme.colorScheme.primaryContainer
                        else
                            MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Row(
                        Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.Top
                    ) {
                        Checkbox(
                            checked = isSelected,
                            onCheckedChange = { checked ->
                                selected = if (checked) selected + i else selected - i
                            }
                        )
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(
                                item.title,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium
                            )
                            if (item.description.isNotBlank()) {
                                Spacer(Modifier.height(2.dp))
                                Text(
                                    item.description,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2
                                )
                            }
                            if (item.pubDate.isNotBlank()) {
                                Spacer(Modifier.height(2.dp))
                                Text(
                                    item.pubDate,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.outline,
                                    fontSize = 10.sp
                                )
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(4.dp))

            // Generate button
            Button(
                onClick = {
                    val lines = selected.sorted().map { newsState.items[it].title }
                    val output = getOutputPath(context, "news_reel_${System.currentTimeMillis()}.mp4")
                    vm.textToVideo(lines, output)
                },
                enabled = selected.isNotEmpty(),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    if (selected.isEmpty()) "Select headlines to create reel"
                    else "Create reel · ${selected.size} slide${if (selected.size != 1) "s" else ""} (~${selected.size * 3}s)"
                )
            }
        }
    }
}
