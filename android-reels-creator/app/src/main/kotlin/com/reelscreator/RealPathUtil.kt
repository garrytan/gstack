package com.reelscreator

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore

/**
 * Resolves a content:// Uri to a filesystem path.
 * Works for MediaStore, Downloads, and file:// Uris across API levels.
 */
object RealPathUtil {

    fun getPath(context: Context, uri: Uri): String? {
        if (uri.scheme == "file") return uri.path

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT && DocumentsContract.isDocumentUri(context, uri)) {
            when {
                isExternalStorageDocument(uri) -> {
                    val docId = DocumentsContract.getDocumentId(uri)
                    val split = docId.split(":")
                    val type = split[0]
                    if ("primary".equals(type, ignoreCase = true)) {
                        return "${Environment.getExternalStorageDirectory()}/${split[1]}"
                    }
                }
                isDownloadsDocument(uri) -> {
                    val id = DocumentsContract.getDocumentId(uri)
                    if (id.startsWith("raw:")) return id.removePrefix("raw:")
                    val contentUri = ContentUris.withAppendedId(
                        Uri.parse("content://downloads/public_downloads"), id.toLongOrNull() ?: return null
                    )
                    return queryContentResolver(context, contentUri)
                }
                isMediaDocument(uri) -> {
                    val docId = DocumentsContract.getDocumentId(uri)
                    val split = docId.split(":")
                    val contentUri = when (split[0]) {
                        "image" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                        "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                        "audio" -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
                        else -> return null
                    }
                    return queryContentResolver(context, contentUri, "_id=?", arrayOf(split[1]))
                }
            }
        }

        if ("content".equals(uri.scheme, ignoreCase = true)) {
            return queryContentResolver(context, uri)
        }

        return null
    }

    private fun queryContentResolver(
        context: Context, uri: Uri,
        selection: String? = null, selectionArgs: Array<String>? = null
    ): String? {
        context.contentResolver.query(uri, arrayOf("_data"), selection, selectionArgs, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val col = cursor.getColumnIndexOrThrow("_data")
                return cursor.getString(col)
            }
        }
        return null
    }

    private fun isExternalStorageDocument(uri: Uri) = "com.android.externalstorage.documents" == uri.authority
    private fun isDownloadsDocument(uri: Uri) = "com.android.providers.downloads.documents" == uri.authority
    private fun isMediaDocument(uri: Uri) = "com.android.providers.media.documents" == uri.authority
}
