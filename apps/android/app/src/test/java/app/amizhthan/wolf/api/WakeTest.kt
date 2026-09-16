package app.amizhthan.wolf.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The web dashboard's wake rules, on the phone. */
class WakeTest {
    private fun pc(
        id: String,
        status: String = "offline",
        remoteAccessEnabled: Boolean = true,
        capabilities: PcCapabilitiesSummary? = PcCapabilitiesSummary(wakeOnLanCapable = true, wakeAddressKnown = true, supportedCommands = listOf("power.wake")),
    ) = PcSummary(id = id, name = id, status = status, registrationState = "active", remoteAccessEnabled = remoteAccessEnabled, capabilities = capabilities)

    @Test
    fun the_command_names_only_the_pc_to_wake() {
        assertEquals("""{"type":"power.wake","payload":{"targetPcId":"01J9ZQK7T0000000000000000A"}}""", Wake.command("01J9ZQK7T0000000000000000A").toString())
    }

    @Test
    fun readiness_follows_status_policy_and_what_the_pc_reported() {
        assertEquals(Wake.Readiness.READY, Wake.readiness(pc("a")))
        assertEquals(Wake.Readiness.ONLINE, Wake.readiness(pc("a", status = "online")))
        assertEquals(Wake.Readiness.SWITCHED_OFF, Wake.readiness(pc("a", remoteAccessEnabled = false)))
        assertEquals(Wake.Readiness.NO_ADDRESS, Wake.readiness(pc("a", capabilities = null)))
        assertEquals(Wake.Readiness.NO_ADDRESS, Wake.readiness(pc("a", capabilities = PcCapabilitiesSummary())))
        assertEquals(Wake.Readiness.NOT_ARMED, Wake.readiness(pc("a", capabilities = PcCapabilitiesSummary(wakeAddressKnown = true))))
    }

    @Test
    fun senders_are_other_online_pcs_that_can_send_a_wake() {
        val target = pc("tower")
        val senders = Wake.senders(
            target,
            listOf(
                target,
                pc("Zeta", status = "online"),
                pc("alpha", status = "online"),
                pc("asleep"),
                pc("off", status = "online", remoteAccessEnabled = false),
                pc("old", status = "online", capabilities = PcCapabilitiesSummary(supportedCommands = listOf("power.action"))),
            ),
        )
        assertEquals(listOf("alpha", "Zeta"), senders.map { it.id })
    }

    @Test
    fun the_result_says_what_was_sent_never_that_the_pc_woke() {
        val text = Wake.sentText("Laptop", "Tower", 6, 1)
        assertTrue(text.startsWith("Laptop sent 6 wake packets for Tower across 1 local network."))
        assertFalse(text.contains("Tower woke"))
    }

    @Test
    fun a_pc_list_from_before_capabilities_were_listed_still_reads() {
        val parsed = WolfJson.decodeFromString(PcList.serializer(), """{"pcs":[{"id":"a","name":"A","status":"offline","registrationState":"active"}]}""")
        assertNull(parsed.pcs.single().capabilities)
    }
}
