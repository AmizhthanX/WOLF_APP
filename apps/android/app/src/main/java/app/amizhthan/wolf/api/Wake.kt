package app.amizhthan.wolf.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Waking a PC from the phone — the web dashboard's rules, word for word.
 *
 * A sleeping PC cannot hear a command, so the wake goes to another of the owner's PCs that is online, which
 * broadcasts a magic packet on its own local networks. WOLF never learns which PCs share a network, so the
 * owner chooses the sender. The phone sends only which PC to wake; the address is filled in by the API from
 * what that PC reported, and the phone never sees it.
 */
object Wake {
    enum class Readiness { ONLINE, SWITCHED_OFF, NO_ADDRESS, NOT_ARMED, READY }

    fun command(targetPcId: String): JsonObject = buildJsonObject {
        put("type", "power.wake")
        putJsonObject("payload") { put("targetPcId", targetPcId) }
    }

    fun readiness(target: PcSummary): Readiness = when {
        target.status == "online" -> Readiness.ONLINE
        !target.remoteAccessEnabled -> Readiness.SWITCHED_OFF
        target.capabilities?.wakeAddressKnown != true -> Readiness.NO_ADDRESS
        !target.capabilities.wakeOnLanCapable -> Readiness.NOT_ARMED
        else -> Readiness.READY
    }

    /** The owner's other PCs that can send a wake packet now, by name. */
    fun senders(target: PcSummary, pcs: List<PcSummary>): List<PcSummary> = pcs
        .filter { it.id != target.id && it.status == "online" && it.remoteAccessEnabled }
        .filter { it.capabilities?.supportedCommands?.contains("power.wake") == true }
        .sortedBy { it.name.lowercase() }

    /** What was done, and only that: a broadcast cannot know whether anything woke. */
    fun sentText(sender: String, target: String, packetsSent: Int, networks: Int): String =
        "$sender sent $packetsSent wake packet${if (packetsSent == 1) "" else "s"} for $target across $networks local " +
            "network${if (networks == 1) "" else "s"}. WOLF shows $target online when its agent connects, usually within a minute " +
            "of it waking. If it does not, it may be on a different network from $sender, or its firmware may not allow waking."
}
