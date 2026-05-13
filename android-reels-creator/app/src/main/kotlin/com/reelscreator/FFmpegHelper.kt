package com.reelscreator

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import com.google.common.collect.ImmutableList
import java.io.File
import java.nio.ByteBuffer

@OptIn(UnstableApi::class)
object FFmpegHelper {

    fun trimVideo(context: Context, input: String, output: String,
                  startSec: Double, durationSec: Double, onDone: (Boolean) -> Unit) {
        val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse("file://$input"))
            .setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs((startSec * 1000).toLong())
                    .setEndPositionMs(((startSec + durationSec) * 1000).toLong())
                    .build()
            )
            .build()
        startSingle(context, EditedMediaItem.Builder(mediaItem).build(), output, onDone)
    }

    fun mergeClips(context: Context, inputs: List<String>, output: String, onDone: (Boolean) -> Unit) {
        val items = inputs.map { p ->
            EditedMediaItem.Builder(MediaItem.fromUri(Uri.parse("file://$p"))).build()
        }
        val composition = Composition.Builder(listOf(EditedMediaItemSequence(items))).build()
        buildTransformer(context, onDone).start(composition, output)
    }

    fun addAudio(videoInput: String, audioInput: String, output: String, onDone: (Boolean) -> Unit) {
        Thread {
            try {
                muxVideoWithAudio(videoInput, audioInput, output)
                onDone(true)
            } catch (_: Exception) {
                onDone(false)
            }
        }.start()
    }

    fun resizeToReels(context: Context, input: String, output: String, onDone: (Boolean) -> Unit) {
        val effects = Effects(
            emptyList(),
            listOf(Presentation.createForWidthAndHeight(
                1080, 1920, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP))
        )
        val editedItem = EditedMediaItem.Builder(MediaItem.fromUri(Uri.parse("file://$input")))
            .setEffects(effects)
            .build()
        startSingle(context, editedItem, output, onDone)
    }

    fun addTextOverlay(context: Context, input: String, output: String,
                       text: String, onDone: (Boolean) -> Unit) {
        val overlay = staticOverlay(captionBitmap(text))
        val effects = Effects(emptyList(), listOf(OverlayEffect(ImmutableList.of(overlay))))
        val editedItem = EditedMediaItem.Builder(MediaItem.fromUri(Uri.parse("file://$input")))
            .setEffects(effects)
            .build()
        startSingle(context, editedItem, output, onDone)
    }

    fun textToVideo(context: Context, lines: List<String>, output: String, onDone: (Boolean) -> Unit) {
        val tmpFiles = mutableListOf<File>()
        try {
            val slides = lines.map { line ->
                val tmp = File.createTempFile("slide_", ".jpg", context.cacheDir)
                tmpFiles += tmp
                slideBitmap(line).let { bmp ->
                    tmp.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
                    bmp.recycle()
                }
                EditedMediaItem.Builder(
                    MediaItem.Builder()
                        .setUri(Uri.fromFile(tmp))
                        .setImageDurationMs(3000L)
                        .build()
                ).setEffects(Effects(
                    emptyList(),
                    listOf(Presentation.createForWidthAndHeight(
                        1080, 1920, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP))
                )).build()
            }
            val composition = Composition.Builder(listOf(EditedMediaItemSequence(slides))).build()
            buildTransformer(context) { ok ->
                tmpFiles.forEach { it.delete() }
                onDone(ok)
            }.start(composition, output)
        } catch (_: Exception) {
            tmpFiles.forEach { it.delete() }
            onDone(false)
        }
    }

    fun addTxtOverlay(context: Context, input: String, output: String,
                      lines: List<String>, videoDurationSec: Double, onDone: (Boolean) -> Unit) {
        if (lines.isEmpty()) { onDone(false); return }
        val sliceDurUs = (videoDurationSec * 1_000_000L / lines.size).toLong()
        val overlay = timedOverlay(lines, sliceDurUs)
        val effects = Effects(emptyList(), listOf(OverlayEffect(ImmutableList.of(overlay))))
        val editedItem = EditedMediaItem.Builder(MediaItem.fromUri(Uri.parse("file://$input")))
            .setEffects(effects)
            .build()
        startSingle(context, editedItem, output, onDone)
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private fun startSingle(context: Context, editedItem: EditedMediaItem,
                            output: String, onDone: (Boolean) -> Unit) {
        buildTransformer(context, onDone).start(editedItem, output)
    }

    private fun buildTransformer(context: Context, onDone: (Boolean) -> Unit): Transformer =
        Transformer.Builder(context)
            .addListener(object : Transformer.Listener {
                override fun onCompleted(composition: Composition, exportResult: ExportResult) =
                    onDone(true)
                override fun onError(composition: Composition, exportResult: ExportResult,
                                     exportException: ExportException) = onDone(false)
            })
            .build()

    private fun staticOverlay(bmp: Bitmap): BitmapOverlay =
        object : BitmapOverlay() {
            override fun getBitmap(presentationTimeUs: Long): Bitmap = bmp
        }

    private fun timedOverlay(lines: List<String>, sliceDurUs: Long): BitmapOverlay {
        val cache = LinkedHashMap<Int, Bitmap>(4, 0.75f, true)
        return object : BitmapOverlay() {
            override fun getBitmap(presentationTimeUs: Long): Bitmap {
                val idx = (presentationTimeUs / sliceDurUs).toInt().coerceIn(0, lines.size - 1)
                return cache.getOrPut(idx) { captionBitmap(lines[idx]) }
            }
        }
    }

    private fun captionBitmap(text: String): Bitmap {
        val w = 1080; val h = 1920
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val bgPaint = Paint().apply { color = Color.argb(160, 0, 0, 0) }
        val txtPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 60f
            typeface = Typeface.DEFAULT_BOLD
            textAlign = Paint.Align.CENTER
        }
        val y = h - 100f
        canvas.drawRect(0f, y - 80f, w.toFloat(), y + 30f, bgPaint)
        canvas.drawText(text.take(80), w / 2f, y, txtPaint)
        return bmp
    }

    private fun slideBitmap(text: String): Bitmap {
        val w = 1080; val h = 1920
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawColor(Color.BLACK)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 72f
            typeface = Typeface.DEFAULT_BOLD
            textAlign = Paint.Align.CENTER
        }
        val maxW = (w - 120).toFloat()
        val words = text.split(" ")
        val wrappedLines = mutableListOf<String>()
        var cur = StringBuilder()
        for (word in words) {
            val test = if (cur.isEmpty()) word else "$cur $word"
            if (paint.measureText(test) > maxW) {
                wrappedLines += cur.toString()
                cur = StringBuilder(word)
            } else {
                cur = StringBuilder(test)
            }
        }
        if (cur.isNotEmpty()) wrappedLines += cur.toString()

        val lineH = paint.textSize + 16f
        var y = (h - wrappedLines.size * lineH) / 2f + paint.textSize
        wrappedLines.forEach { line ->
            canvas.drawText(line, w / 2f, y, paint)
            y += lineH
        }
        return bmp
    }

    private fun muxVideoWithAudio(videoPath: String, audioPath: String, outputPath: String) {
        val vEx = MediaExtractor().apply { setDataSource(videoPath) }
        val aEx = MediaExtractor().apply { setDataSource(audioPath) }

        val vTrack = (0 until vEx.trackCount).first {
            vEx.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
        }
        val aTrack = (0 until aEx.trackCount).first {
            aEx.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        }
        vEx.selectTrack(vTrack); aEx.selectTrack(aTrack)

        val vFmt = vEx.getTrackFormat(vTrack)
        val aFmt = aEx.getTrackFormat(aTrack)
        val durUs = runCatching { vFmt.getLong(MediaFormat.KEY_DURATION) }.getOrDefault(Long.MAX_VALUE)

        val muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        val muxV = muxer.addTrack(vFmt)
        val muxA = muxer.addTrack(aFmt)
        muxer.start()

        val buf = ByteBuffer.allocate(1024 * 1024)
        val info = MediaCodec.BufferInfo()

        fun copyTrack(ex: MediaExtractor, muxTrack: Int, limitUs: Long = Long.MAX_VALUE) {
            while (true) {
                val size = ex.readSampleData(buf, 0)
                if (size < 0 || ex.sampleTime > limitUs) break
                info.set(0, size, ex.sampleTime,
                    if (ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
                        MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                muxer.writeSampleData(muxTrack, buf, info)
                ex.advance()
            }
        }

        copyTrack(vEx, muxV)
        copyTrack(aEx, muxA, durUs)

        muxer.stop(); muxer.release()
        vEx.release(); aEx.release()
    }
}
