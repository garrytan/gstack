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

    // These feeds are tested on real Android devices (home/mobile IP).
    // Cloud/datacenter IPs are blocked by most news CDNs — that is expected.
    val feeds = linkedMapOf(
        "BBC News"        to "https://feeds.bbci.co.uk/news/rss.xml",
        "Google News"     to "https://news.google.com/rss",
        "Al Jazeera"      to "https://www.aljazeera.com/xml/rss/all.xml",
        "NPR News"        to "https://feeds.npr.org/1001/rss.xml",
        "The Guardian"    to "https://www.theguardian.com/world/rss",
        "NY Times"        to "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
        "Sky News"        to "https://feeds.skynews.com/feeds/rss/home.xml",
        "Deutsche Welle"  to "https://rss.dw.com/rdf/rss-en-all"
    )

    suspend fun fetch(url: String): Result<List<NewsItem>> = withContext(Dispatchers.IO) {
        runCatching {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 12_000
            conn.readTimeout = 12_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"
            )
            conn.setRequestProperty("Accept", "application/rss+xml, application/xml, text/xml, */*")
            conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9")
            try {
                conn.inputStream.use { parseRss(it) }
            } finally {
                conn.disconnect()
            }
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
