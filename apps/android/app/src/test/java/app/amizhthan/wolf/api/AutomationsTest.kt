package app.amizhthan.wolf.api

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The automations and alert rules the phone builds, held to `packages/protocol` shape and bounds. */
class AutomationsTest {
    private val pc = "01J9ZQK7T0000000000000000P"

    private fun refused(block: () -> Unit): String = try {
        block()
        fail("expected a refusal")
        ""
    } catch (error: IllegalArgumentException) {
        error.message.orEmpty()
    }

    @Test
    fun an_automation_is_the_protocol_shape_field_for_field() {
        val definition = Automations.definition(
            name = "  Nightly restart ",
            trigger = Automations.schedule("03:00", Automations.DAYS, "UTC"),
            conditions = listOf(Automations.noActiveSession()),
            actions = listOf(Automations.power("restart", 60)),
            targets = Automations.onPcs(listOf(pc)),
        )

        assertEquals(
            """{"name":"Nightly restart","enabled":true,"trigger":{"kind":"schedule","time":"03:00","days":["mon","tue","wed","thu","fri","sat","sun"],"timeZone":"UTC"},""" +
                """"conditions":[{"kind":"no-active-session"}],"actions":[{"kind":"command","command":{"type":"power.action","payload":{"action":"restart","delaySeconds":60,"force":false}}}],""" +
                """"targets":{"mode":"pcs","pcIds":["$pc"]},"cooldownMinutes":60,"maxRunsPerDay":4}""",
            definition.toString(),
        )
    }

    @Test
    fun days_are_sent_in_week_order_and_times_are_24_hour() {
        assertEquals(
            """{"kind":"schedule","time":"23:59","days":["mon","sun"],"timeZone":"Europe/London"}""",
            Automations.schedule("23:59", listOf("sun", "mon"), "Europe/London").toString(),
        )
        listOf("3:00", "24:00", "12:60", "noon", "").forEach { time -> refused { Automations.schedule(time, Automations.DAYS, "UTC") } }
        refused { Automations.schedule("03:00", emptyList(), "UTC") }
        refused { Automations.schedule("03:00", listOf("someday"), "UTC") }
        refused { Automations.timeWindow("22:00", "6:00", Automations.DAYS, "UTC") }
    }

    @Test
    fun an_alert_trigger_for_any_rule_says_so_with_null() {
        assertEquals("""{"kind":"alert","ruleId":null,"on":"fired"}""", Automations.onAlert(null, "fired").toString())
        refused { Automations.onAlert(null, "changed") }
    }

    @Test
    fun the_pc_the_alert_fired_for_needs_an_alert_trigger() {
        val message = refused {
            Automations.definition("x", Automations.manual(), emptyList(), listOf(Automations.notify("hi", "info")), Automations.alertPc())
        }
        assertTrue(message.contains("alert trigger"))

        Automations.definition("x", Automations.onAlert(null, "fired"), emptyList(), listOf(Automations.notify("hi", "info")), Automations.alertPc())
    }

    @Test
    fun an_automation_is_bounded_the_way_the_server_bounds_it() {
        val notify = Automations.notify("hi", "info")
        val targets = Automations.onPcs(listOf(pc))
        fun build(name: String = "x", actions: Int = 1, conditions: Int = 0, cooldown: Int = 60, runs: Int = 4) = Automations.definition(
            name, Automations.manual(), List(conditions) { Automations.noActiveSession() }, List(actions) { notify }, targets, cooldown, runs,
        )

        build(actions = 5, conditions = 5, cooldown = 10_080, runs = 96)
        refused { build(actions = 0) }
        refused { build(actions = 6) }
        refused { build(conditions = 6) }
        refused { build(cooldown = 0) }
        refused { build(runs = 97) }
        refused { build(name = "   ") }
        refused { build(name = "n".repeat(121)) }
        refused { Automations.onPcs(emptyList()) }
        refused { Automations.onPcs(listOf(pc, pc)) }
        refused { Automations.onPcs(List(21) { "01J9ZQK7T00000000000000${it.toString().padStart(3, '0')}" }) }
    }

    @Test
    fun power_actions_are_never_forced_and_wait_at_most_a_day() {
        val command = Automations.power("shutdown", 86_400)["command"]!!.jsonObject
        assertEquals("false", command["payload"]!!.jsonObject["force"].toString())
        assertEquals("86400", command["payload"]!!.jsonObject["delaySeconds"].toString())

        refused { Automations.power("shutdown", -1) }
        refused { Automations.power("shutdown", 86_401) }
        refused { Automations.power("format", 0) }
        // The PC screen's power buttons still send no delay.
        assertEquals("0", Commands.power("lock")["payload"]!!.jsonObject["delaySeconds"].toString())
    }

    @Test
    fun a_notification_is_trimmed_and_bounded() {
        assertEquals("""{"kind":"notify","severity":"warning","message":"Disk nearly full"}""", Automations.notify("  Disk nearly full ", "warning").toString())
        refused { Automations.notify("   ", "info") }
        refused { Automations.notify("m".repeat(201), "info") }
        refused { Automations.notify("hi", "urgent") }
        refused { Automations.cpuBelow(0.0) }
        refused { Automations.cpuBelow(Double.NaN) }
    }

    @Test
    fun automations_are_described_in_the_dashboard_words() {
        val rules = mapOf("01J9ZQK7T0000000000000000R" to "Disk nearly full")
        assertEquals("At 03:00 on every day (UTC)", Automations.describeTrigger(Automations.schedule("03:00", Automations.DAYS, "UTC")) { rules[it] })
        assertEquals("At 22:30 on sat, sun (UTC)", Automations.describeTrigger(Automations.schedule("22:30", listOf("sat", "sun"), "UTC")) { rules[it] })
        assertEquals("When Disk nearly full fires", Automations.describeTrigger(Automations.onAlert("01J9ZQK7T0000000000000000R", "fired")) { rules[it] })
        assertEquals("When a deleted rule resolves", Automations.describeTrigger(Automations.onAlert("01J9ZQK7T0000000000000000X", "resolved")) { rules[it] })
        assertEquals("When any alert rule fires", Automations.describeTrigger(Automations.onAlert(null, "fired")) { rules[it] })
        assertEquals("Only when run by hand", Automations.describeTrigger(Automations.manual()) { null })

        assertEquals("restart the PC after 60 s", Automations.describeAction(Automations.power("restart", 60)))
        assertEquals("lock the PC", Automations.describeAction(Automations.power("lock", 0)))
        assertEquals("notify \"Hello\"", Automations.describeAction(Automations.notify("Hello", "info")))
        val service = buildJsonObject {
            put("kind", "command")
            putJsonObject("command") {
                put("type", "service.control")
                putJsonObject("payload") {
                    put("name", "Spooler")
                    put("action", "restart")
                }
            }
        }
        assertEquals("restart service Spooler", Automations.describeAction(service))

        assertEquals("DESKTOP, LAPTOP", Automations.describeTargets(Automations.onPcs(listOf("a".repeat(26), "b".repeat(26)))) { if (it.startsWith("a")) "DESKTOP" else "LAPTOP" })
        assertEquals("the PC the alert fired for", Automations.describeTargets(Automations.alertPc()) { it })
        assertEquals("CPU usage is below 20%", Automations.describeCondition(Automations.cpuBelow(20.0)))
        assertEquals("it is between 22:00 and 06:00", Automations.describeCondition(Automations.timeWindow("22:00", "06:00", Automations.DAYS, "UTC")))
    }

    @Test
    fun what_this_app_does_not_model_is_shown_by_name_not_dropped() {
        val listed = WolfJson.decodeFromString(
            AutomationList.serializer(),
            """{"automations":[{"id":"01J9ZQK7T0000000000000000A","name":"Future","enabled":true,"trigger":{"kind":"webhook","path":"/x"},"conditions":[{"kind":"on-battery"}],"actions":[{"kind":"script"}],"targets":{"mode":"tagged","tag":"lab"},"cooldownMinutes":60,"maxRunsPerDay":4,"authorizedRiskLevel":"medium","authorizedAt":"2026-09-15T00:00:00Z","createdAt":"2026-09-15T00:00:00Z","updatedAt":"2026-09-15T00:00:00Z"}],"limit":50}""",
        ).automations.single()

        assertTrue(Automations.describeTrigger(listed.trigger) { null }.contains("webhook"))
        assertEquals("on-battery", Automations.describeCondition(listed.conditions.single()))
        assertEquals("script", Automations.describeAction(listed.actions.single()))
        assertEquals("tagged", Automations.describeTargets(listed.targets) { it })
        assertFalse(Automations.runsByHand(listed.targets))
        assertNull(listed.lastRunAt)
    }

    @Test
    fun run_reasons_are_worded_and_unknown_ones_passed_through() {
        assertEquals("A condition was not met — cpu.usage is 64", Automations.describeReason("condition-not-met: cpu.usage is 64"))
        assertEquals("The PC was offline", Automations.describeReason("pc-offline"))
        assertEquals("brand-new-reason", Automations.describeReason("brand-new-reason"))
        assertEquals("service.control: failed (service.not_found)", Automations.describeStep(AutomationStepView(0, "command", "failed", null, "service.control", "service.not_found")))
    }

    @Test
    fun an_offline_rule_carries_no_metric_and_a_metric_rule_needs_one() {
        val offline = AlertRules.rule("PC gone", null, "pc-offline", "cpu.usage", 90.0, "C:", 10, "critical", 60)
        assertNull(offline.metric)
        assertNull(offline.threshold)
        // Nulls are left out, so the server applies its own defaults for them.
        assertEquals(
            """{"name":"PC gone","condition":"pc-offline","forMinutes":10,"severity":"critical","cooldownMinutes":60,"enabled":true}""",
            WolfJson.encodeToString(AlertRuleInput.serializer(), offline),
        )

        refused { AlertRules.rule("Hot", pc, "metric-above", "cpu.temperature", null, null, 10, "warning", 60) }
        refused { AlertRules.rule("Hot", pc, "metric-above", "cpu.fanSpeed", 90.0, null, 10, "warning", 60) }
        refused { AlertRules.rule("Hot", pc, "metric-sideways", "cpu.usage", 90.0, null, 10, "warning", 60) }
        refused { AlertRules.rule("Hot", pc, "metric-above", "cpu.usage", 90.0, null, 0, "warning", 60) }
    }

    @Test
    fun a_device_is_kept_only_for_metrics_that_have_devices() {
        assertNull(AlertRules.rule("CPU", pc, "metric-above", "cpu.usage", 90.0, "C:", 10, "warning", 60).seriesKey)
        assertEquals("C:", AlertRules.rule("Disk", pc, "metric-above", "disk.usedPercent", 90.0, "  C: ", 10, "warning", 60).seriesKey)
        assertNull(AlertRules.rule("Disk", pc, "metric-above", "disk.usedPercent", 90.0, "   ", 10, "warning", 60).seriesKey)
    }

    @Test
    fun the_quiet_period_keeps_the_server_floor() {
        refused { AlertRules.rule("Flappy", null, "pc-offline", null, null, null, 10, "info", 4) }
        AlertRules.rule("Flappy", null, "pc-offline", null, null, null, 10, "info", 5)
    }

    @Test
    fun rules_and_notifications_are_described() {
        val disk = AlertRuleView("01J9ZQK7T0000000000000000R", pc, "Disk", "metric-above", "disk.usedPercent", "C:", 90.0, 30, "warning", 120, true, "t", "t")
        assertEquals("Disk used (C:) on DESKTOP above 90% for 30 min · quiet 120 min after notifying", AlertRules.describe(disk, "DESKTOP"))
        assertEquals(
            "every PC offline for 10 min · quiet 60 min after notifying",
            AlertRules.describe(disk.copy(condition = "pc-offline", metric = null, threshold = null, forMinutes = 10, cooldownMinutes = 60), "every PC"),
        )
        assertEquals(
            "Battery charge on LAPTOP below 12.5% for 5 min · quiet 60 min after notifying",
            AlertRules.describe(disk.copy(condition = "metric-below", metric = "battery.charge", seriesKey = null, threshold = 12.5, forMinutes = 5, cooldownMinutes = 60), "LAPTOP"),
        )

        val fired = NotificationView("n", kind = "fired", severity = "critical", title = "t", occurredAt = "t")
        assertEquals("Critical", AlertRules.label(fired))
        assertEquals("Resolved", AlertRules.label(fired.copy(kind = "resolved")))
        assertEquals("Automation · info", AlertRules.label(fired.copy(kind = "automation", severity = "info")))
    }
}
