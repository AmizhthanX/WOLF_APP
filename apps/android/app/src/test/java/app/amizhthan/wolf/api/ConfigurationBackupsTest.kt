package app.amizhthan.wolf.api

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The backup file on the phone: what is refused before anything is sent, and what is kept exactly. */
class ConfigurationBackupsTest {
    private val file =
        """{"format":"wolf.configuration","version":1,"createdAt":"2026-09-15T08:30:00.000Z","checksum":"${"a".repeat(64)}",""" +
            """"content":{"pcs":[{"id":"01J9ZQK7T0000000000000000P","name":"DESKTOP","tags":["home"],"favorite":true}],"remoteDesktopProfiles":[],""" +
            """"alertRules":[{"id":"01J9ZQK7T0000000000000000R","rule":{"name":"Disk","pcId":null,"condition":"metric-above","metric":"disk.usedPercent","seriesKey":"C:","threshold":99.5,"forMinutes":30,"severity":"warning","cooldownMinutes":120,"enabled":true}}],""" +
            """"automations":[]}}"""

    private fun refusal(text: String): String = refusal(text.toByteArray())

    private fun refusal(bytes: ByteArray): String = try {
        ConfigurationBackups.parse(bytes)
        fail("expected the file to be refused")
        ""
    } catch (error: BackupFileException) {
        assertEquals("Nothing was changed.", error.problem.currentState)
        error.problem.code
    }

    @Test
    fun a_wolf_backup_is_accepted_named_by_its_date_and_counted_not_quoted() {
        val backup = ConfigurationBackups.parse(file.toByteArray())

        assertEquals("wolf-configuration-2026-09-15.json", ConfigurationBackups.fileName(backup))
        assertEquals("1 PC · 0 profiles · 1 alert rule · 0 automations · made 2026-09-15", ConfigurationBackups.summary(backup))
        assertFalse("names stay out of the summary", ConfigurationBackups.summary(backup).contains("DESKTOP"))
    }

    @Test
    fun what_is_saved_is_what_the_server_sent_value_for_value() {
        val backup = ConfigurationBackups.parse(file.toByteArray())
        val text = ConfigurationBackups.text(backup)

        assertEquals(WolfJson.parseToJsonElement(file), WolfJson.parseToJsonElement(text))
        // Numbers are written as they came: 30 stays 30, not 30.0, so the file reads the same to the server.
        assertTrue(text.contains("\"forMinutes\": 30,"))
        assertTrue(text.contains("\"threshold\": 99.5,"))
        assertEquals(backup, ConfigurationBackups.parse(text.toByteArray()))
    }

    @Test
    fun a_byte_order_mark_added_by_an_editor_is_not_damage() {
        ConfigurationBackups.parse(("﻿" + file).toByteArray())
    }

    @Test
    fun files_that_are_not_backups_are_refused_before_anything_is_sent() {
        assertEquals("configuration.unreadable", refusal("not json at all"))
        assertEquals("configuration.unreadable", refusal("[1,2,3]"))
        assertEquals("configuration.unreadable", refusal(""))
        assertEquals("configuration.not_a_backup", refusal("""{"format":"something.else","content":{}}"""))
        assertEquals("configuration.not_a_backup", refusal("""{"format":"wolf.configuration"}"""))
        assertEquals("configuration.not_a_backup", refusal("""{"format":"wolf.configuration","content":[]}"""))
        assertEquals("configuration.file_too_large", refusal(ByteArray(ConfigurationBackups.MAX_FILE_BYTES + 1) { ' '.code.toByte() }))
    }

    @Test
    fun a_newer_format_is_left_for_the_server_to_judge() {
        // The server knows which versions it reads; refusing here could block a restore it would accept.
        ConfigurationBackups.parse(file.replace("\"version\":1", "\"version\":2").toByteArray())
    }

    @Test
    fun a_backup_without_a_readable_date_gets_a_plain_name() {
        assertEquals("wolf-configuration.json", ConfigurationBackups.fileName(buildJsonObject { put("createdAt", "yesterday/../x") }))
        assertEquals("wolf-configuration.json", ConfigurationBackups.fileName(buildJsonObject { }))
    }

    @Test
    fun sections_keep_the_dashboard_order_whatever_order_they_are_chosen_in() {
        assertEquals(listOf("pcs", "automations"), ConfigurationBackups.toggle(listOf("automations"), "pcs", true))
        assertEquals(
            listOf("pcs", "remoteDesktopProfiles", "automations"),
            ConfigurationBackups.toggle(ConfigurationBackups.SECTIONS.map { it.id }, "alertRules", false),
        )
    }

    @Test
    fun a_plan_is_described_with_its_counts_its_automations_and_its_risk() {
        val plan = RestorePlan(
            sections = mapOf("alertRules" to RestoreSectionCounts(1, 2, 3, 0), "pcs" to RestoreSectionCounts(0, 4, 0, 1)),
            automationsEnabled = 0,
            riskLevel = "medium",
        )

        assertEquals(
            listOf(
                "PC names and tags: 0 created, 4 updated, 0 deleted, 1 skipped",
                "Alert rules: 1 created, 2 updated, 3 deleted, 0 skipped",
                "Restored automations will be off. Confirmed at medium risk.",
            ),
            ConfigurationBackups.describe(plan),
        )
        assertEquals("This replaces the chosen configuration with the backup's.", ConfigurationBackups.restoreDescription(plan, enableAutomations = true))
        assertTrue(ConfigurationBackups.restoreDescription(plan.copy(automationsEnabled = 2, riskLevel = "high"), enableAutomations = true).contains("turns on 2 automation(s)"))
    }
}
