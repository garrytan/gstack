package com.reelscreator

import android.content.Context
import android.os.Environment

fun getOutputPath(context: Context, filename: String): String {
    val dir = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)
    return "${dir?.absolutePath}/$filename"
}

fun getFontPath(context: Context): String {
    val fontFile = java.io.File(context.filesDir, "Roboto-Regular.ttf")
    if (!fontFile.exists()) {
        context.assets.open("Roboto-Regular.ttf").use { input ->
            fontFile.outputStream().use { output -> input.copyTo(output) }
        }
    }
    return fontFile.absolutePath
}
