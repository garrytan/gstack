package com.reelscreator

import android.content.Context
import android.net.Uri
import android.os.Environment

fun getOutputPath(context: Context, filename: String): String {
    val dir = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)
    return "${dir?.absolutePath}/$filename"
}

// Copies a content:// URI to a private cache file and returns the path.
// Media3 Transformer requires a real filesystem path, not a content URI.
fun Uri.copyToCacheFile(context: Context, suffix: String = ".mp4"): String? {
    return try {
        val tmp = java.io.File(context.cacheDir, "media_${System.currentTimeMillis()}$suffix")
        context.contentResolver.openInputStream(this)?.use { input ->
            tmp.outputStream().use { input.copyTo(it) }
        }
        tmp.absolutePath
    } catch (_: Exception) {
        null
    }
}
