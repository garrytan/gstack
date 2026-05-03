package com.reelscreator

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.net.HttpURLConnection
import java.net.URL

data class NewsItem(
    val title: String,
    val description: String = "",
    val pubDate: String = "",
    val link: String = ""
)

object RssRepository {

    val feeds = linkedMapOf(
        "BBC News" to "https://feeds.bbci.co.uk/news/rss.xml",
        "Google Top Stories" to "https://news.google.com/rss",
        "Al Jazeera" to "https://www.aljazeera.com/xml/rss/all.xml",
        "NPR News" to "https://feeds.npr.org/1001/rss.xml",
        "The Guardian" to "https://www.theguardian.com/world/rss",
        "NY Times" to "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"
    )

    suspend fun fetch(url: String): Result<List<NewsItem>> = withContext(Dispatchers.IO) {
        runCatching {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 12_000
            conn.readTimeout = 12_000
            conn.setRequestProperty("User-Agent", "ReelsCreator/1.0")
            conn.inputStream.use { parseRss(it) }
        }
    }

    private fun parseRss(stream: java.io.InputStream): List<NewsItem> {
        val factory = XmlPullParserFactory.newInstance().apply { isNamespaceAware = false }
        val parser = factory.newPullParser()
        parser.setInput(stream, null)

        val items = mutableListOf<NewsItem>()
        var inItem = false
        var tag = ""
        var title = StringBuilder()
        var desc = StringBuilder()
        var date = StringBuilder()
        var link = StringBuilder()

        var event = parser.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> {
                    tag = parser.name.lowercase()
                    if (tag == "item" || tag == "entry") {
                        inItem = true
                        title.clear(); desc.clear(); date.clear(); link.clear()
                    }
                }
                XmlPullParser.END_TAG -> {
                    val endTag = parser.name.lowercase()
                    if ((endTag == "item" || endTag == "entry") && inItem) {
                        val t = title.toString().trim()
                        if (t.isNotBlank()) {
                            items.add(
                                NewsItem(
                                    title = t.cleanHtml(),
                                    description = desc.toString().trim().cleanHtml().take(120),
                                    pubDate = date.toString().trim().take(30),
                                    link = link.toString().trim()
                                )
                            )
                        }
                        inItem = false
                    }
                    tag = ""
                }
                XmlPullParser.TEXT -> {
                    if (inItem) {
                        val text = parser.text ?: ""
                        when (tag) {
                            "title" -> title.append(text)
                            "description", "summary", "content" -> desc.append(text)
                            "pubdate", "published", "updated", "dc:date" -> date.append(text)
                            "link" -> link.append(text)
                        }
                    }
                }
            }
            event = parser.next()
        }

        return items.take(25)
    }

    private fun String.cleanHtml(): String =
        replace(Regex("<[^>]+>"), "")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&#39;", "'")
            .trim()
}
