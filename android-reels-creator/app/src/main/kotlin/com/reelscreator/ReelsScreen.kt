package com.reelscreator

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReelsScreen(vm: ReelsViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    var selectedTab by remember { mutableIntStateOf(0) }
    val tabs = listOf("News", "Trim", "Merge", "Audio", "Resize", "Caption", "Text→Video", "TXT")
    val context = LocalContext.current

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reels Creator") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer
                )
            )
        }
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
        ) {
            ScrollableTabRow(selectedTabIndex = selectedTab) {
                tabs.forEachIndexed { i, title ->
                    Tab(
                        selected = selectedTab == i,
                        onClick = {
                            selectedTab = i
                            vm.clearResult()
                        },
                        text = { Text(title) }
                    )
                }
            }

            if (state.isProcessing) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(
                    "Processing...",
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.bodySmall
                )
            }

            state.error?.let { err ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
                ) {
                    Text(
                        "Error: $err",
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(12.dp)
                    )
                }
            }

            state.outputPath?.takeIf { it.isNotEmpty() }?.let { path ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF1B5E20))
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text("Saved: $path", color = Color.White, style = MaterialTheme.typography.bodySmall)
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(
                                onClick = {
                                    val intent = Intent(Intent.ACTION_SEND).apply {
                                        type = "video/mp4"
                                        putExtra(Intent.EXTRA_STREAM, Uri.parse("file://$path"))
                                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                    }
                                    context.startActivity(Intent.createChooser(intent, "Share video"))
                                },
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)
                            ) {
                                Icon(Icons.Default.Share, contentDescription = null)
                                Spacer(Modifier.width(4.dp))
                                Text("Share")
                            }
                            OutlinedButton(
                                onClick = {
                                    saveToGallery(context, path)
                                        .onSuccess {
                                            Toast.makeText(context, "Saved to Movies/ReelsCreator", Toast.LENGTH_SHORT).show()
                                        }
                                        .onFailure {
                                            Toast.makeText(context, "Download failed: ${it.message}", Toast.LENGTH_LONG).show()
                                        }
                                },
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)
                            ) {
                                Icon(Icons.Default.Download, contentDescription = null)
                                Spacer(Modifier.width(4.dp))
                                Text("Download")
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        VideoPreview(path, modifier = Modifier.fillMaxWidth())
                    }
                }
            }

            Box(
                Modifier
                    .padding(16.dp)
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
            ) {
                when (selectedTab) {
                    0 -> NewsFeedTab(vm)
                    1 -> TrimTab(vm)
                    2 -> MergeTab(vm)
                    3 -> AudioTab(vm)
                    4 -> ResizeTab(vm)
                    5 -> CaptionTab(vm)
                    6 -> TextToVideoTab(vm)
                    7 -> TxtOverlayTab(vm)
                }
            }
        }
    }
}
