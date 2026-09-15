package app.amizhthan.wolf.api

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.ZoneOffset

/** Services, scheduled tasks and startup items: the commands held to the protocol, the results as the agent sends them. */
class PcToolsCommandsTest {
    private fun refused(block: () -> Unit) {
        try {
            block()
            fail("expected a refusal")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun service_commands_are_the_protocol_shape() {
        assertEquals("""{"type":"service.list","payload":{}}""", Commands.serviceList().toString())
        assertEquals(
            """{"type":"service.control","payload":{"name":"Spooler","action":"stop","expectedDisplayName":"Print Spooler"}}""",
            Commands.serviceControl("Spooler", "stop", "Print Spooler").toString(),
        )
        assertEquals(
            """{"type":"service.set-start-type","payload":{"name":"Spooler","startType":"manual","expectedDisplayName":"Print Spooler"}}""",
            Commands.serviceSetStartType("Spooler", "manual", "Print Spooler").toString(),
        )
    }

    @Test
    fun a_service_is_named_the_way_sc_names_it_and_carries_what_the_list_showed() {
        refused { Commands.serviceControl("Print Spooler", "stop", "Print Spooler") }
        refused { Commands.serviceControl("..\\Spooler", "stop", "Print Spooler") }
        refused { Commands.serviceControl("a/b", "stop", "Print Spooler") }
        refused { Commands.serviceControl("", "stop", "Print Spooler") }
        refused { Commands.serviceControl("s".repeat(257), "stop", "Print Spooler") }
        refused { Commands.serviceControl("Spooler", "pause", "Print Spooler") }
        refused { Commands.serviceControl("Spooler", "stop", "") }
    }

    @Test
    fun boot_and_system_start_types_are_readable_and_never_settable() {
        refused { Commands.serviceSetStartType("disk", "boot", "Disk Driver") }
        refused { Commands.serviceSetStartType("disk", "system", "Disk Driver") }
        refused { Commands.serviceSetStartType("Spooler", "sometimes", "Print Spooler") }
    }

    @Test
    fun a_task_path_is_rooted_and_cannot_climb_out_of_itself() {
        assertEquals(
            """{"type":"task.control","payload":{"path":"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","action":"run","expectedName":"ScheduledDefrag"}}""",
            Commands.taskControl("\\Microsoft\\Windows\\Defrag\\ScheduledDefrag", "run", "ScheduledDefrag").toString(),
        )
        Commands.taskControl("\\Backup Jobs\\Nightly copy", "disable", "Nightly copy")

        refused { Commands.taskControl("Microsoft\\Windows\\Defrag", "run", "Defrag") }
        refused { Commands.taskControl("\\Microsoft\\..\\Windows", "run", "x") }
        refused { Commands.taskControl("\\Microsoft/Windows", "run", "x") }
        refused { Commands.taskControl("\\Microsoft\\Win*", "run", "x") }
        refused { Commands.taskControl("", "run", "x") }
        refused { Commands.taskControl("\\Backup", "delete", "Backup") }
    }

    @Test
    fun a_startup_change_carries_no_command_to_run() {
        val payload = Commands.startupSetEnabled("OneDrive", "user", "run", false)["payload"]!!.jsonObject
        assertEquals(setOf("name", "scope", "source", "enabled"), payload.keys)
        assertEquals("""{"type":"startup.list","payload":{}}""", Commands.startupList().toString())

        refused { Commands.startupSetEnabled("OneDrive", "everyone", "run", false) }
        refused { Commands.startupSetEnabled("OneDrive", "user", "services", false) }
        refused { Commands.startupSetEnabled("", "user", "run", false) }
    }

    @Test
    fun lists_decode_what_the_agent_sends() {
        val services = WolfJson.decodeFromString(
            ServiceListResult.serializer(),
            """{"services":[{"name":"Spooler","displayName":"Print Spooler","status":"running","startType":null,"account":"LocalSystem","imagePath":"C:\\Windows\\spoolsv.exe","canStop":true,"protectedBy":null,"future":1}],"helperAvailable":true,"unavailableReason":null,"at":"2026-09-15T00:00:00Z"}""",
        )
        assertEquals("Print Spooler", services.services.single().displayName)
        assertEquals("unknown", PcTools.startType(services.services.single().startType))

        val unavailable = WolfJson.decodeFromString(
            TaskListResult.serializer(),
            """{"tasks":[],"truncated":false,"helperAvailable":false,"unavailableReason":"The WOLF privileged helper is not installed.","at":"x"}""",
        )
        assertFalse(unavailable.helperAvailable)
        assertEquals("The WOLF privileged helper is not installed.", unavailable.unavailableReason)

        val tasks = WolfJson.decodeFromString(
            TaskListResult.serializer(),
            """{"tasks":[{"path":"\\Backup\\Nightly","name":"Nightly","enabled":true,"state":"ready","lastRunAt":null,"nextRunAt":"2026-09-16T03:00:00+05:30","lastResult":267011,"author":null,"account":"SYSTEM","actions":["C:\\backup.exe --all"],"protectedBy":null}],"truncated":true}""",
        )
        assertTrue(tasks.truncated)
        assertTrue(tasks.helperAvailable)
        assertEquals("C:\\backup.exe --all", tasks.tasks.single().actions.single())

        val startup = WolfJson.decodeFromString(
            StartupListResult.serializer(),
            """{"entries":[{"name":"OneDrive","command":null,"scope":"user","source":"run","user":"owner","enabled":false,"protectedBy":"wolf-startup"}],"truncated":false,"helperAvailable":true}""",
        )
        assertNull(startup.entries.single().command)
        assertEquals("WOLF's own startup entry.", PcTools.protection(startup.entries.single().protectedBy!!))

        val changed = WolfJson.decodeFromString(ServiceChangeResult.serializer(), """{"name":"Spooler","displayName":"Print Spooler","status":"stopped","note":null,"at":"x"}""")
        assertEquals("stopped", changed.status)
        assertNull(changed.note)
    }

    @Test
    fun words_for_what_this_app_does_not_know_are_the_codes_themselves() {
        assertEquals("some-new-protection", PcTools.protection("some-new-protection"))
        assertEquals("scheduled-hook", PcTools.source("scheduled-hook"))
        assertEquals("Automatic (delayed)", PcTools.startType("automatic-delayed"))
        assertEquals("Startup folder", PcTools.source("startup-folder"))
    }

    @Test
    fun scheduler_times_are_shown_as_local_times_or_not_at_all() {
        val offset = PcTools.localTime("2026-09-15T03:00:00+05:30", ZoneOffset.UTC)
        assertNotNull(offset)
        assertEquals(offset, PcTools.localTime("2026-09-14T21:30:00Z", ZoneOffset.UTC))
        assertNull(PcTools.localTime("never", ZoneOffset.UTC))
        assertNull(PcTools.localTime("", ZoneOffset.UTC))
    }

    @Test
    fun service_task_and_startup_actions_are_automations_the_protocol_accepts() {
        assertEquals(
            """{"kind":"command","command":{"type":"service.control","payload":{"name":"Spooler","action":"restart","expectedDisplayName":"Print Spooler"}}}""",
            Automations.serviceControl("Spooler", "restart", "Print Spooler").toString(),
        )
        assertEquals("restart service Spooler", Automations.describeAction(Automations.serviceControl("Spooler", "restart", "Print Spooler")))
        assertEquals("run task \\Backup\\Nightly", Automations.describeAction(Automations.taskControl("\\Backup\\Nightly", "run", "Nightly")))
        assertEquals("disable startup item OneDrive", Automations.describeAction(Automations.startupSetEnabled("OneDrive", "user", "run", false)))
        refused { Automations.taskControl("Backup\\Nightly", "run", "Nightly") }
    }
}
