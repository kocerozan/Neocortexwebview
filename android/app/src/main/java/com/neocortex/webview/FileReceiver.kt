package com.neocortex.webview

import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

sealed class BridgeEvent {
    object None : BridgeEvent()
    object Ready : BridgeEvent()
    object Close : BridgeEvent()
    data class Complete(val image: File?, val video: File?, val clips: Int) : BridgeEvent()
}

/**
 * Web tarafının gönderdiği file.begin / file.chunk / file.end mesajlarını diske yazar.
 * Her chunk bağımsız base64'tür (3'ün katı bayt), sırayla eklenir.
 */
class FileReceiver(private val dir: File) {
    private class Pending(val file: File, val out: FileOutputStream, val total: Int) { var next = 0 }

    private val pending = HashMap<String, Pending>()
    private val finished = HashMap<String, File>()

    init { dir.mkdirs() }

    fun handle(json: String): BridgeEvent {
        val m = runCatching { JSONObject(json) }.getOrNull() ?: return BridgeEvent.None
        val id = m.optString("id")
        when (m.optString("type")) {
            "ready" -> return BridgeEvent.Ready
            "close" -> return BridgeEvent.Close
            "file.begin" -> {
                val mime = m.optString("mimeType")
                val ext = when {
                    "mp4" in mime -> "mp4"
                    "webm" in mime -> "webm"
                    "jpeg" in mime -> "jpg"
                    else -> "bin"
                }
                pending.remove(id)?.out?.close()
                val f = File(dir, "${safe(id)}.$ext")
                pending[id] = Pending(f, FileOutputStream(f), m.optInt("chunks"))
            }
            "file.chunk" -> {
                val p = pending[id] ?: return BridgeEvent.None
                if (m.optInt("index", -1) != p.next) return BridgeEvent.None
                p.out.write(Base64.decode(m.optString("data"), Base64.DEFAULT))
                p.next++
            }
            "file.end" -> {
                val p = pending.remove(id) ?: return BridgeEvent.None
                p.out.close()
                if (p.next == p.total) finished[id] = p.file else p.file.delete()
            }
            "result.complete" -> return BridgeEvent.Complete(
                image = finished[m.optString("imageId")],
                video = finished[m.optString("videoId")],
                clips = m.optInt("clips"),
            )
        }
        return BridgeEvent.None
    }

    private fun safe(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_")
}
