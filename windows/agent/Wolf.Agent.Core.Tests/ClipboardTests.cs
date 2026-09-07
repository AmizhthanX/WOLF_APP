using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.SessionHost.Clipboard;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Clipboard sharing, against the real Windows clipboard.
///
/// Two things are being protected here and neither is about plumbing. The first is the
/// grant: `clipboard` is a session capability of its own, and a session that can watch a
/// screen has not thereby been given the contents of whatever the person at that machine
/// last copied. The second is that nothing is retained — not in the cloud, which never sees
/// it, and not in a log, because a clipboard routinely holds a password.
///
/// These tests do put text on the machine's clipboard, which is unavoidable when testing a
/// clipboard. They restore whatever was there when they finish.
/// </summary>
[Collection("Capture")]
public sealed class ClipboardTests : IDisposable
{
    private readonly ITestOutputHelper _output;
    private readonly string? _original;

    public ClipboardTests(ITestOutputHelper output)
    {
        _output = output;

        // Whatever the person running these tests had copied is put back afterwards.
        _original = WindowsClipboard.TryReadText(NullLogger.Instance);
    }

    public void Dispose()
    {
        if (_original is not null) WindowsClipboard.TryWriteText(_original, NullLogger.Instance);
    }

    private const string StreamId = "01J9ZQK7T0000000000000000B";

    private static ClipboardChannel Channel(
        List<ClipboardOffer>? offers = null,
        List<string>? unsupported = null) =>
        new(
            StreamId,
            offer => offers?.Add(offer),
            describes => unsupported?.Add(describes),
            NullLogger<ClipboardChannel>.Instance);

    /* --------------------------------------------------------------------- */
    /* The Windows clipboard itself                                           */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Text_written_to_the_clipboard_reads_back_unchanged()
    {
        const string text = "WOLF clipboard round trip — with a dash, an emoji 🐺, and\ttabs.";

        Assert.True(WindowsClipboard.TryWriteText(text, NullLogger.Instance));
        Assert.Equal(text, WindowsClipboard.TryReadText(NullLogger.Instance));

        // Unicode has to survive: a clipboard that mangles anything outside ASCII is worse
        // than one that refuses, because the damage is only noticed after it is pasted.
        Assert.Equal(ClipboardKind.Text, WindowsClipboard.Inspect());
    }

    [Fact]
    public void The_sequence_number_changes_when_the_clipboard_does()
    {
        WindowsClipboard.TryWriteText("first", NullLogger.Instance);
        uint before = WindowsClipboard.SequenceNumber;

        WindowsClipboard.TryWriteText("second", NullLogger.Instance);
        uint after = WindowsClipboard.SequenceNumber;

        _output.WriteLine($"sequence {before} -> {after}");

        // This counter is what the watcher polls instead of running a message window. If it
        // did not move, clipboard changes would go unnoticed.
        Assert.NotEqual(before, after);
    }

    [Fact]
    public void A_large_paste_still_round_trips()
    {
        string text = new('x', 200_000);

        Assert.True(WindowsClipboard.TryWriteText(text, NullLogger.Instance));
        Assert.Equal(text.Length, WindowsClipboard.TryReadText(NullLogger.Instance)?.Length);
    }

    /* --------------------------------------------------------------------- */
    /* The grant                                                              */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Without_the_capability_nothing_is_read_and_nothing_is_written()
    {
        var offers = new List<ClipboardOffer>();
        using ClipboardChannel channel = Channel(offers);

        channel.Start(allowed: false);

        WindowsClipboard.TryWriteText("something the operator copied", NullLogger.Instance);
        Thread.Sleep(900);

        // Not read and withheld — not read at all. The watcher never starts.
        Assert.Empty(offers);
        Assert.False(channel.IsAllowed);

        ClipboardRefusal? refusal = channel.Apply("text from the client");
        _output.WriteLine(refusal?.Detail);

        Assert.NotNull(refusal);
        Assert.Equal("not-permitted", refusal!.Reason);

        // And the PC's clipboard is untouched by the attempt.
        Assert.Equal("something the operator copied", WindowsClipboard.TryReadText(NullLogger.Instance));
    }

    [Fact]
    public void With_the_capability_content_from_the_client_reaches_the_clipboard()
    {
        using ClipboardChannel channel = Channel();
        channel.Start(allowed: true);

        Assert.Null(channel.Apply("pasted from the viewer"));
        Assert.Equal("pasted from the viewer", WindowsClipboard.TryReadText(NullLogger.Instance));
        Assert.Equal(1, channel.TimesApplied);
    }

    /* --------------------------------------------------------------------- */
    /* Watching, and not looping                                              */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_copy_on_the_PC_is_offered_to_the_viewer()
    {
        var offers = new List<ClipboardOffer>();
        using ClipboardChannel channel = Channel(offers);

        channel.Start(allowed: true);
        WindowsClipboard.TryWriteText("copied on the PC", NullLogger.Instance);

        Assert.True(WaitFor(() => offers.Count > 0, TimeSpan.FromSeconds(3)));

        _output.WriteLine($"{offers.Count} offer(s), first is {offers[0].Text.Length} characters");
        Assert.Equal("copied on the PC", offers[0].Text);
    }

    [Fact]
    public void What_the_client_sent_is_not_offered_straight_back()
    {
        var offers = new List<ClipboardOffer>();
        using ClipboardChannel channel = Channel(offers);

        channel.Start(allowed: true);
        Assert.Null(channel.Apply("sent from the viewer"));

        // Applying content changes the PC's clipboard, which looks exactly like somebody
        // copying. Without remembering it, the two machines would trade this string forever.
        Thread.Sleep(1500);

        _output.WriteLine($"{offers.Count} offer(s) after applying content from the client");
        Assert.Empty(offers);
    }

    [Fact]
    public void A_stream_does_not_ship_whatever_was_already_on_the_clipboard()
    {
        WindowsClipboard.TryWriteText("private, copied before the stream began", NullLogger.Instance);

        var offers = new List<ClipboardOffer>();
        using ClipboardChannel channel = Channel(offers);

        channel.Start(allowed: true);
        Thread.Sleep(1200);

        // Opening a stream is not an instruction to hand over what the user last copied.
        // Only what they copy *afterwards* is shared.
        Assert.Empty(offers);
    }

    [Fact]
    public void Copying_something_WOLF_cannot_carry_is_named_rather_than_ignored()
    {
        var offers = new List<ClipboardOffer>();
        var unsupported = new List<string>();
        using ClipboardChannel channel = Channel(offers, unsupported);

        channel.Start(allowed: true);

        if (!TrySetFileDrop())
        {
            _output.WriteLine("The clipboard would not take a file list; skipping.");
            return;
        }

        bool named = WaitFor(() => unsupported.Count > 0, TimeSpan.FromSeconds(3));

        _output.WriteLine(named ? $"described as: {unsupported[0]}" : "nothing was reported");

        // Somebody who copies a file and finds nothing on the other machine should be told
        // WOLF does not move files, not left concluding clipboard sharing is broken.
        Assert.True(named, "copying a file list was not reported");
        Assert.Equal("files", unsupported[0]);
        Assert.Empty(offers);
    }

    /* --------------------------------------------------------------------- */
    /* Bounds                                                                 */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Content_past_the_limit_is_refused_rather_than_truncated()
    {
        using ClipboardChannel channel = Channel();
        channel.Start(allowed: true);

        ClipboardRefusal? refusal = channel.Apply(new string('x', ClipboardChannel.MaxTextLength + 1));

        _output.WriteLine(refusal?.Detail);

        // A silently shortened paste is worse than one that did not happen: the operator
        // does not find out until whatever they pasted is broken.
        Assert.NotNull(refusal);
        Assert.Equal("too-large", refusal!.Reason);
    }

    [Fact]
    public void An_oversized_clipboard_on_the_PC_is_not_offered()
    {
        var offers = new List<ClipboardOffer>();
        using ClipboardChannel channel = Channel(offers);

        channel.Start(allowed: true);
        WindowsClipboard.TryWriteText(new string('y', ClipboardChannel.MaxTextLength + 1000), NullLogger.Instance);

        Thread.Sleep(1500);

        _output.WriteLine($"{offers.Count} offer(s) for content past the limit");
        Assert.Empty(offers);
    }

    private static bool WaitFor(Func<bool> condition, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return true;
            Thread.Sleep(50);
        }

        return condition();
    }

    /// <summary>
    /// Put a file list on the clipboard, the way Explorer does when you copy a file.
    ///
    /// Built by hand rather than through WinForms: pulling a UI framework into the test
    /// project for one assertion is disproportionate, and the structure is a header and a
    /// double-null-terminated list of paths.
    /// </summary>
    private static bool TrySetFileDrop()
    {
        const uint CfHdrop = 15;
        const uint GlobalMoveable = 0x0002;

        string path = AppContext.BaseDirectory;

        // DROPFILES, then the paths, then two terminating nulls.
        int headerBytes = 20;
        int pathBytes = (path.Length + 2) * sizeof(char);

        if (!OpenClipboard(IntPtr.Zero)) return false;

        IntPtr block = IntPtr.Zero;

        try
        {
            if (!EmptyClipboard()) return false;

            block = GlobalAlloc(GlobalMoveable, (UIntPtr)(headerBytes + pathBytes));
            if (block == IntPtr.Zero) return false;

            IntPtr pointer = GlobalLock(block);
            if (pointer == IntPtr.Zero) return false;

            try
            {
                Marshal.WriteInt32(pointer, 0, headerBytes); // pFiles: where the list starts
                Marshal.WriteInt32(pointer, 4, 0);           // pt.x
                Marshal.WriteInt32(pointer, 8, 0);           // pt.y
                Marshal.WriteInt32(pointer, 12, 0);          // fNC
                Marshal.WriteInt32(pointer, 16, 1);          // fWide: the paths are UTF-16

                IntPtr list = pointer + headerBytes;
                Marshal.Copy(path.ToCharArray(), 0, list, path.Length);
                Marshal.WriteInt16(list, path.Length * sizeof(char), 0);
                Marshal.WriteInt16(list, (path.Length + 1) * sizeof(char), 0);
            }
            finally
            {
                GlobalUnlock(block);
            }

            if (SetClipboardData(CfHdrop, block) == IntPtr.Zero) return false;

            // The clipboard owns it now.
            block = IntPtr.Zero;
            return true;
        }
        finally
        {
            if (block != IntPtr.Zero) GlobalFree(block);
            CloseClipboard();
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenClipboard(IntPtr owner);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll")]
    private static extern IntPtr SetClipboardData(uint format, IntPtr data);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalLock(IntPtr handle);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalUnlock(IntPtr handle);
}
