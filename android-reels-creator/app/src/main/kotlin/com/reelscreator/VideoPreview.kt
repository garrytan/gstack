package com.reelscreator

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

@Composable
fun VideoPreview(path: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val player = remember {
        ExoPlayer.Builder(context).build().also { exo ->
            exo.setMediaItem(MediaItem.fromUri(Uri.parse("file://$path")))
            exo.prepare()
        }
    }

    DisposableEffect(path) {
        player.setMediaItem(MediaItem.fromUri(Uri.parse("file://$path")))
        player.prepare()
        onDispose { player.release() }
    }

    Column(modifier) {
        Text("Preview", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(bottom = 4.dp))
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    this.player = player
                    useController = true
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(9f / 16f)
        )
    }
}
