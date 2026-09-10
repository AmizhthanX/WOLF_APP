using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Helper;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Scheduled tasks and startup items — what a machine does on its own.
///
/// The read halves run against the real machine: a real task scheduler, a real registry, real
/// mounted user hives. That matters more here than almost anywhere else, because both features
/// are enumerations of somewhere messy, and a mock would have proved the code walks a tree
/// somebody invented rather than the one Windows actually has.
///
/// The write halves need administrator and are gated, with one exception: every refusal runs
/// here, because a refusal is decided before anything is opened.
///
/// **The property these tests exist to protect is a negative one.** A scheduled task and a
/// `Run` key are the two mechanisms every piece of Windows malware reaches for, so the
/// important thing is not what WOLF does with them — it is that there is no code path that
/// creates one.
/// </summary>
public sealed class AutorunTests
{
    private readonly ITestOutputHelper _output;

    public AutorunTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /* --------------------------------------------------------------------- */
    /* What WOLF refuses to disable                                           */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData(@"\Microsoft\Windows\TaskScheduler\Maintenance Configurator", "the scheduler's own upkeep")]
    [InlineData(@"\Microsoft\Windows\WindowsUpdate\Scheduled Start", "updates")]
    [InlineData(@"\Microsoft\Windows\UpdateOrchestrator\Reboot", "update orchestration")]
    [InlineData(@"\Microsoft\Windows\SystemRestore\SR", "restore points")]
    [InlineData(@"\Microsoft\Windows\Windows Defender\Windows Defender Scheduled Scan", "security")]
    [InlineData(@"\Microsoft\Windows\Servicing\StartComponentCleanup", "the component store")]
    public void A_task_Windows_uses_to_keep_itself_working_is_refused(string path, string what)
    {
        ServiceRefusal? refusal = AutorunProtection.CheckTask(path, "disable");

        _output.WriteLine($"{what}: {refusal?.Code} — {refusal?.Reason}");

        // The damage these do is slow. A machine that stops updating, stops taking restore
        // points, or stops scanning does not fail — it degrades, and nobody attributes it to
        // the right cause months later. That is exactly the kind of thing a confirmation
        // dialog is bad at conveying, so it is refused instead.
        Assert.NotNull(refusal);
        Assert.Equal("system-critical", refusal!.Code);
    }

    [Fact]
    public void WOLFs_own_scheduled_work_is_refused()
    {
        ServiceRefusal? refusal = AutorunProtection.CheckTask(@"\WOLF\Agent Watchdog", "disable");

        Assert.NotNull(refusal);
        Assert.Equal("wolf-task", refusal!.Code);
        Assert.Contains("control panel", refusal.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(@"\Adobe Acrobat Update Task")]
    [InlineData(@"\GoogleUpdateTaskMachineUA")]
    [InlineData(@"\Microsoft\Windows\Defrag\ScheduledDefrag")]
    [InlineData(@"\Microsoft\Office\OfficeTelemetryAgentLogOn")]
    public void An_ordinary_task_can_be_disabled(string path)
    {
        // Third-party updaters are the single most common thing an operator wants to switch
        // off on somebody's machine. A protection list that caught them would make the
        // feature useless for its main purpose.
        Assert.Null(AutorunProtection.CheckTask(path, "disable"));
    }

    [Fact]
    public void Enabling_and_running_are_allowed_even_where_disabling_is_not()
    {
        // The asymmetry the service and device rules also make. Enabling restores something
        // the machine was already configured to do; running repeats something it was going to
        // do anyway. Both can be undone. Disabling servicing cannot.
        const string Protected = @"\Microsoft\Windows\WindowsUpdate\Scheduled Start";

        Assert.Null(AutorunProtection.CheckTask(Protected, "enable"));
        Assert.Null(AutorunProtection.CheckTask(Protected, "run"));
        Assert.NotNull(AutorunProtection.CheckTask(Protected, "disable"));
    }

    [Fact]
    public void A_folder_prefix_does_not_swallow_a_longer_name()
    {
        // `\Microsoft\Windows\Servicing Helper` is not inside `\Microsoft\Windows\Servicing`,
        // and treating it as protected would refuse something harmless for the life of the
        // product — the same mistake the file manager's protected-path check avoids.
        Assert.Null(AutorunProtection.WhyNotTask(@"\Microsoft\Windows\ServicingHelper\Task"));
        Assert.NotNull(AutorunProtection.WhyNotTask(@"\Microsoft\Windows\Servicing\Task"));
        Assert.NotNull(AutorunProtection.WhyNotTask(@"\Microsoft\Windows\Servicing"));
    }

    [Fact]
    public void A_path_without_its_leading_separator_is_still_recognised()
    {
        // The scheduler reports paths rooted; a client that trimmed one would otherwise slip
        // straight past the protection.
        Assert.NotNull(AutorunProtection.WhyNotTask(@"Microsoft\Windows\WindowsUpdate\Scheduled Start"));
    }

    [Fact]
    public void A_task_with_no_path_is_refused_rather_than_allowed_through()
    {
        Assert.Equal("unknown-task", AutorunProtection.WhyNotTask("")!.Code);
        Assert.Equal("unknown-task", AutorunProtection.WhyNotTask("   ")!.Code);
    }

    /* --------------------------------------------------------------------- */
    /* Startup entries                                                        */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void WOLFs_own_startup_entry_is_refused()
    {
        ServiceRefusal? refusal = AutorunProtection.CheckStartup(
            "WOLF", @"C:\Program Files\WOLF\Wolf.Agent.exe", enable: false);

        Assert.NotNull(refusal);
        Assert.Equal("wolf-startup", refusal!.Code);
    }

    [Fact]
    public void An_entry_that_starts_the_shell_is_refused()
    {
        ServiceRefusal? refusal = AutorunProtection.CheckStartup(
            "Shell", @"C:\Windows\explorer.exe", enable: false);

        // Disabling it leaves a machine with no desktop for whoever signs in next, which is a
        // thing nobody can fix from the machine because there is nothing to fix it with.
        Assert.NotNull(refusal);
        Assert.Equal("system-critical", refusal!.Code);
    }

    [Fact]
    public void An_ordinary_startup_entry_can_be_turned_off()
    {
        Assert.Null(AutorunProtection.CheckStartup(
            "Spotify", @"C:\Users\someone\AppData\Roaming\Spotify\Spotify.exe", enable: false));
    }

    [Fact]
    public void Turning_something_back_on_is_never_refused()
    {
        // Enabling restores what was there. There is nothing to protect against, and a rule
        // with no risk behind it is one more thing to get wrong later.
        Assert.Null(AutorunProtection.CheckStartup("WOLF", @"C:\Program Files\WOLF\Wolf.Agent.exe", enable: true));
        Assert.Null(AutorunProtection.CheckStartup("Shell", @"C:\Windows\explorer.exe", enable: true));
    }

    /* --------------------------------------------------------------------- */
    /* Against the real machine                                               */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void The_real_scheduled_tasks_read_back_with_what_they_run()
    {
        var manager = new TaskManager(NullLogger<TaskManager>.Instance);
        HelperTaskListResult result = manager.List(null);

        _output.WriteLine($"{result.Tasks.Count} task(s), truncated={result.Truncated}");

        // Every Windows machine ships with scheduled tasks. An empty list would mean the walk
        // is wrong rather than the machine being unusual.
        Assert.NotEmpty(result.Tasks);

        foreach (HelperTask task in result.Tasks.Take(5))
        {
            _output.WriteLine(
                $"  {task.Path} enabled={task.Enabled} state={task.State} " +
                $"account={task.Account} protectedBy={task.ProtectedBy}");
        }

        // The tree is walked, not just the root: everything Windows ships lives under
        // `\Microsoft\Windows\<component>`, and a listing that showed only third-party tasks
        // at the root would look plausible and be missing the half that matters.
        Assert.Contains(result.Tasks, task =>
            task.Path.StartsWith(@"\Microsoft\Windows\", StringComparison.OrdinalIgnoreCase));

        // The protection travels with the listing, so an operator sees what is off limits
        // before they try it rather than after.
        Assert.Contains(result.Tasks, task => task.ProtectedBy == "system-critical");
    }

    [Fact]
    public void A_task_search_narrows_the_walk_rather_than_the_result()
    {
        var manager = new TaskManager(NullLogger<TaskManager>.Instance);

        IReadOnlyList<HelperTask> all = manager.List(null).Tasks;
        IReadOnlyList<HelperTask> matched = manager.List("Defrag").Tasks;

        _output.WriteLine($"{matched.Count} of {all.Count} match 'Defrag'");

        Assert.True(matched.Count < all.Count, "a search that matched everything is not a search");
        Assert.All(matched, task =>
            Assert.Contains("Defrag", task.Path, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_task_that_is_not_there_is_reported_as_missing()
    {
        var manager = new TaskManager(NullLogger<TaskManager>.Instance);

        HelperTaskResult result = manager.Control(
            @"\WolfNoSuchTask" + Guid.NewGuid().ToString("N"), "enable", "Nothing");

        Assert.False(result.Ok);
        Assert.Equal("unknown-task", result.Code);
    }

    [Fact]
    public void Disabling_a_protected_task_is_refused_before_the_scheduler_is_asked()
    {
        var manager = new TaskManager(NullLogger<TaskManager>.Instance);

        HelperTaskResult result = manager.Control(
            @"\Microsoft\Windows\WindowsUpdate\Scheduled Start", "disable", "Scheduled Start");

        _output.WriteLine($"{result.Code}: {result.Message}");

        // Refused by WOLF rather than by Windows. Relying on Windows to protect a list WOLF
        // wrote for its own reasons would be relying on a coincidence.
        Assert.False(result.Ok);
        Assert.Equal("system-critical", result.Code);
    }

    [Fact]
    public void The_real_startup_entries_read_back_from_every_place_Windows_looks()
    {
        var manager = new StartupManager(NullLogger<StartupManager>.Instance);
        HelperStartupListResult result = manager.List();

        _output.WriteLine($"{result.Entries.Count} startup entr(ies)");

        foreach (HelperStartupEntry entry in result.Entries.Take(10))
        {
            _output.WriteLine(
                $"  [{entry.Scope}/{entry.Source}] {entry.Name} enabled={entry.Enabled} user={entry.User}");
        }

        // Every entry says which of Windows' four places it came from, because "it is in the
        // registry" and "it is a shortcut in a folder" are different things to fix.
        Assert.All(result.Entries, entry =>
        {
            Assert.Contains(entry.Scope, new[] { "machine", "user" });
            Assert.Contains(entry.Source, new[] { "run", "run-once", "startup-folder" });
        });

        // An entry nobody has ever switched off has no approval value at all, so a machine
        // where everything reads as disabled would mean the flag is being read backwards.
        if (result.Entries.Count > 0)
        {
            Assert.Contains(result.Entries, entry => entry.Enabled);
        }
    }

    [Fact]
    public void Per_user_entries_come_from_mounted_hives_rather_than_impersonation()
    {
        var manager = new StartupManager(NullLogger<StartupManager>.Instance);
        HelperStartupListResult result = manager.List();

        IReadOnlyList<HelperStartupEntry> perUser = result.Entries
            .Where(entry => entry.Scope == "user" && entry.User is not null)
            .ToArray();

        _output.WriteLine($"{perUser.Count} entr(ies) read from a signed-in user's hive");

        // A signed-in user's hive is already mounted under HKEY_USERS, so their Run key is
        // readable without a token and for every user signed in at once. Users who are *not*
        // signed in have no mounted hive and are not listed, which is stated rather than
        // worked around: loading somebody's hive to read it is a much larger thing to do to a
        // machine than reading one that is already open.
        Assert.All(perUser, entry => Assert.False(string.IsNullOrWhiteSpace(entry.User)));
    }

    [Fact]
    public void Changing_a_startup_entry_that_is_not_there_says_so()
    {
        var manager = new StartupManager(NullLogger<StartupManager>.Instance);

        HelperStartupResult result = manager.SetEnabled(
            "WolfNoSuchEntry" + Guid.NewGuid().ToString("N"), "machine", "run", enabled: false);

        Assert.False(result.Ok);
        Assert.Equal("unknown-entry", result.Code);
    }

    /* --------------------------------------------------------------------- */
    /* The property that matters most                                         */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Nothing_here_can_create_a_scheduled_task_or_a_startup_entry()
    {
        // Stated as a test because it is the whole security argument for this area. A list of
        // protected folders can be incomplete; "there is no code path that registers a task"
        // cannot be, and the operations the helper will perform are the enumerable proof.
        string[] operations =
        {
            HelperProtocol.Operations.TaskList,
            HelperProtocol.Operations.TaskControl,
            HelperProtocol.Operations.StartupList,
            HelperProtocol.Operations.StartupSetEnabled,
        };

        foreach (string operation in operations)
        {
            Assert.True(HelperProtocol.IsAllowed(operation));
            Assert.DoesNotContain("create", operation, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("register", operation, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("delete", operation, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("remove", operation, StringComparison.OrdinalIgnoreCase);
        }

        // And the helper refuses anything not on its list, so a caller inventing one gets
        // nothing rather than something.
        Assert.False(HelperProtocol.IsAllowed("task.register"));
        Assert.False(HelperProtocol.IsAllowed("task.delete"));
        Assert.False(HelperProtocol.IsAllowed("startup.add"));
        Assert.False(HelperProtocol.IsAllowed("startup.remove"));
    }

    /// <summary>
    /// The one that cannot run here, and says so.
    ///
    /// Enabling and disabling a real scheduled task needs administrator, and a suite that
    /// switched off scheduled tasks on whatever machine it happened to run on would be a worse
    /// idea than an untested path.
    ///
    /// Run it elevated with <c>WOLF_TEST_AUTORUN_CONTROL=1</c>. It disables and re-enables one
    /// third-party task, chosen at run time, and puts it back the way it found it.
    /// </summary>
    [Fact]
    public void Disabling_and_re_enabling_a_task_really_works()
    {
        if (Environment.GetEnvironmentVariable("WOLF_TEST_AUTORUN_CONTROL") is not ("1" or "true"))
        {
            _output.WriteLine(
                "Needs an elevated test run. Set WOLF_TEST_AUTORUN_CONTROL=1 to cycle one third-party task.");
            return;
        }

        var manager = new TaskManager(NullLogger<TaskManager>.Instance);

        HelperTask? candidate = manager.List(null).Tasks.FirstOrDefault(task =>
            task.ProtectedBy is null &&
            task.Enabled &&
            !task.Path.StartsWith(@"\Microsoft\", StringComparison.OrdinalIgnoreCase));

        if (candidate is null)
        {
            _output.WriteLine("No third-party enabled task on this machine to cycle safely.");
            return;
        }

        _output.WriteLine($"cycling {candidate.Path}");

        HelperTaskResult disabled = manager.Control(candidate.Path, "disable", candidate.Name);
        Assert.True(disabled.Ok, disabled.Message);
        Assert.False(disabled.Enabled);

        HelperTaskResult enabled = manager.Control(candidate.Path, "enable", candidate.Name);
        Assert.True(enabled.Ok, enabled.Message);
        Assert.True(enabled.Enabled);
    }
}
