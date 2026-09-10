using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// Windows scheduled tasks.
///
/// Reached through the Task Scheduler 2.0 COM API, late-bound. Declaring `ITaskService`,
/// `ITaskFolder`, `IRegisteredTask` and their collections as `ComImport` interfaces would be
/// several hundred lines of interop for the six members actually used here, and every one of
/// them is a vtable offset that fails silently if it is wrong. The alternatives were worse:
/// there is no first-party managed wrapper in the framework, and driving `schtasks.exe` would
/// mean parsing localised console output to decide whether something ran.
///
/// **WOLF does not register or delete tasks.** `RegisterTaskDefinition` and `DeleteTask` are
/// never called and no operation reaches them. A scheduled task is the first thing every piece
/// of Windows malware creates, and a remote-management tool that can create one is a remote
/// persistence tool whatever else it is. What is here manages tasks that already exist.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TaskManager
{
    /// <summary>
    /// How deep the folder tree is walked.
    ///
    /// `\Microsoft\Windows\<component>` is three levels, and everything Windows ships lives at
    /// four or less. A bound exists because the tree is writable by anything with
    /// administrator, and an unbounded walk is a helper that can be made to spin by creating
    /// a deep enough folder.
    /// </summary>
    private const int MaxDepth = 6;

    /// <summary>Tasks returned at once. Beyond this the listing says it was truncated.</summary>
    public const int MaxTasks = 2000;

    /// <summary>Include tasks that are hidden from the Task Scheduler UI.</summary>
    private const int IncludeHidden = 1;

    private readonly ILogger<TaskManager> _logger;

    public TaskManager(ILogger<TaskManager> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Every scheduled task on the machine, with what WOLF would refuse to do to each.
    ///
    /// Hidden tasks are included. A task hidden from the Task Scheduler UI is more interesting
    /// to somebody investigating a machine than a visible one, not less, and a list that
    /// quietly omitted them would be worse than no list.
    /// </summary>
    public HelperTaskListResult List(string? search)
    {
        dynamic? service = Connect();

        if (service is null)
        {
            return new HelperTaskListResult(Array.Empty<HelperTask>(), false);
        }

        var tasks = new List<HelperTask>();
        bool truncated = false;

        try
        {
            Walk(service.GetFolder("\\"), search, tasks, ref truncated, 0);
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException
                                       or IOException
                                       or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "The scheduled task tree could not be read in full.");
        }

        tasks.Sort((left, right) => string.Compare(left.Path, right.Path, StringComparison.OrdinalIgnoreCase));
        return new HelperTaskListResult(tasks, truncated);
    }

    private void Walk(dynamic folder, string? search, List<HelperTask> tasks, ref bool truncated, int depth)
    {
        foreach (dynamic task in folder.GetTasks(IncludeHidden))
        {
            if (tasks.Count >= MaxTasks)
            {
                // Said rather than silently cut, for the same reason a directory listing says
                // it: a list that shows part of itself with no indication is one somebody
                // concludes does not contain what they are looking for.
                truncated = true;
                return;
            }

            HelperTask? described = Describe(task, search);
            if (described is not null) tasks.Add(described);
        }

        if (depth >= MaxDepth) return;

        foreach (dynamic sub in folder.GetFolders(0))
        {
            Walk(sub, search, tasks, ref truncated, depth + 1);
        }
    }

    private HelperTask? Describe(dynamic task, string? search)
    {
        string path;
        string name;

        try
        {
            path = (string)task.Path;
            name = (string)task.Name;
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or IOException)
        {
            // A task that vanished between the enumeration and this read. Skipped rather than
            // failing the whole listing for one entry.
            return null;
        }

        if (search is { Length: > 0 } &&
            !path.Contains(search, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        bool enabled = Try(() => (bool)task.Enabled, false);
        int state = Try(() => (int)task.State, 0);
        string? lastRun = Try(() => FormatTime(task.LastRunTime), null);
        string? nextRun = Try(() => FormatTime(task.NextRunTime), null);
        int lastResult = Try(() => (int)task.LastTaskResult, 0);

        string? author = null;
        string? account = null;
        var actions = new List<string>();

        try
        {
            dynamic definition = task.Definition;
            author = Try(() => (string?)definition.RegistrationInfo.Author, null);
            account = Try(() => (string?)definition.Principal.UserId, null);

            foreach (dynamic action in definition.Actions)
            {
                // Type 0 is an executable. The other kinds — COM handler, e-mail, message box
                // — are deprecated and carry nothing an operator can act on, so what is
                // reported for them is the kind rather than an invented command line.
                if (Try(() => (int)action.Type, -1) == 0)
                {
                    string? execPath = Try(() => (string?)action.Path, null);
                    string? arguments = Try(() => (string?)action.Arguments, null);
                    actions.Add(string.IsNullOrWhiteSpace(arguments) ? execPath ?? "" : $"{execPath} {arguments}");
                }
                else
                {
                    actions.Add("(not a program)");
                }

                if (actions.Count >= 4) break;
            }
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException
                                       or IOException
                                       or UnauthorizedAccessException)
        {
            // A task whose definition cannot be read is still worth listing: its name, folder
            // and enabled state are the fields an operator scans first.
        }

        return new HelperTask(
            path,
            name,
            enabled,
            StateName(state),
            lastRun,
            nextRun,
            lastResult,
            author,
            account,
            actions,
            AutorunProtection.WhyNotTask(path)?.Code);
    }

    /// <summary>
    /// Turn a task on or off, or run it now.
    ///
    /// The result reports what the task scheduler says afterwards rather than what was asked
    /// for — the same rule as services, and for the same reason.
    /// </summary>
    public HelperTaskResult Control(string taskPath, string action, string expectedName)
    {
        ServiceRefusal? refusal = AutorunProtection.CheckTask(taskPath, action);
        if (refusal is not null)
        {
            return new HelperTaskResult(taskPath, expectedName, false, false, refusal.Code, refusal.Reason);
        }

        dynamic? service = Connect();
        if (service is null)
        {
            return new HelperTaskResult(
                taskPath, expectedName, false, false, "unavailable",
                "The Windows task scheduler could not be reached on this PC.");
        }

        dynamic task;

        try
        {
            task = service.GetFolder("\\").GetTask(taskPath);
        }
        // `IOException` is here because of what the late-bound COM binder does with HRESULTs:
        // a task that is not there comes back as `FileNotFoundException`, not as a
        // `COMException`. Caught by the first test that asked for a task that did not exist,
        // which is the reason that test asks for one.
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException
                                       or IOException
                                       or UnauthorizedAccessException)
        {
            return new HelperTaskResult(
                taskPath, expectedName, false, false, "unknown-task",
                "There is no scheduled task at that path on this PC.");
        }

        string actualName = Try(() => (string)task.Name, expectedName) ?? expectedName;

        // Checked before anything happens, the way a service's display name is and a process
        // id is checked against its name. A task list read a minute ago can describe a
        // machine that has changed since.
        if (!string.Equals(actualName, expectedName, StringComparison.OrdinalIgnoreCase))
        {
            return new HelperTaskResult(
                taskPath, actualName, false, Try(() => (bool)task.Enabled, false), "name-mismatch",
                $"That task is called '{actualName}' on this PC now, not '{expectedName}'. Nothing was changed.");
        }

        try
        {
            switch (action)
            {
                case "enable":
                    task.Enabled = true;
                    break;

                case "disable":
                    task.Enabled = false;
                    break;

                case "run":
                    // Running a configured task is not creating one, but it is still asking
                    // the machine to execute something. The command registry classifies it
                    // high for that reason; what happens here is only the request.
                    task.Run(Type.Missing);
                    break;

                default:
                    return new HelperTaskResult(
                        taskPath, actualName, false, Try(() => (bool)task.Enabled, false), "malformed",
                        $"'{action}' is not something WOLF does to a scheduled task.");
            }
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException
                                       or IOException
                                       or UnauthorizedAccessException)
        {
            _logger.LogWarning("A scheduled task could not be {Action}d.", action);


            return new HelperTaskResult(
                taskPath, actualName, false, Try(() => (bool)task.Enabled, false), "failed",
                "Windows would not perform that on this task.");
        }

        bool nowEnabled = Try(() => (bool)task.Enabled, action != "disable");
        _logger.LogInformation("Scheduled task {Action}d; it is now {State}.", action, nowEnabled ? "enabled" : "disabled");

        return new HelperTaskResult(taskPath, actualName, true, nowEnabled, null, null);
    }

    private dynamic? Connect()
    {
        try
        {
            Type? type = Type.GetTypeFromProgID("Schedule.Service");
            if (type is null) return null;

            dynamic? service = Activator.CreateInstance(type);
            service?.Connect();
            return service;
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException
                                       or UnauthorizedAccessException
                                       or NotSupportedException)
        {
            _logger.LogWarning(ex, "The Windows task scheduler could not be reached.");
            return null;
        }
    }

    /// <summary>
    /// Read one COM property, or fall back.
    ///
    /// The task scheduler throws for properties that do not apply — `NextRunTime` on a task
    /// with no future trigger is the common one — and a listing that failed on the first of
    /// those would show nothing at all.
    /// </summary>
    private static T Try<T>(Func<T> read, T fallback)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException
                                       or IOException
                                       or UnauthorizedAccessException
                                       or InvalidCastException
                                       or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            return fallback;
        }
    }

    private static string? FormatTime(object? value) =>
        value is DateTime time && time.Year > 1900 ? time.ToUniversalTime().ToString("o") : null;

    /// <summary>The scheduler's numeric state, as a word.</summary>
    private static string StateName(int state) => state switch
    {
        0 => "unknown",
        1 => "disabled",
        2 => "queued",
        3 => "ready",
        4 => "running",
        _ => "unknown",
    };
}
