using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Clipboard;

/// <summary>What the clipboard holds, without saying what it says.</summary>
public enum ClipboardKind
{
    /// <summary>Nothing WOLF recognises, or nothing at all.</summary>
    Empty,

    Text,

    /// <summary>An image. Named but never carried; see the channel above for why.</summary>
    Image,

    /// <summary>Files. Moving these is a separate feature with its own rules.</summary>
    Files,
}

/// <summary>
/// The Windows clipboard, read and written as text.
///
/// Two things this deliberately does not do. It never writes clipboard content to a log —
/// only lengths and kinds — because a clipboard routinely holds passwords, and a log is the
/// last place they should end up. And it does not use a clipboard-listener window: a message
/// window plus a pump is a hundred lines of interop to learn something
/// <c>GetClipboardSequenceNumber</c> answers in one call, and polling a counter twice a
/// second costs nothing measurable.
///
/// Every operation can fail benignly. The clipboard is a single shared resource and any
/// application may hold it open for a moment, so failures here are retried and then reported
/// rather than treated as faults.
/// </summary>
[SupportedOSPlatform("windows")]
public static partial class WindowsClipboard
{
    /// <summary>How many times to wait for another application to release the clipboard.</summary>
    private const int OpenAttempts = 5;

    private const int OpenRetryDelayMs = 20;

    private const uint CfText = 13; // CF_UNICODETEXT
    private const uint CfBitmap = 2;
    private const uint CfDib = 8;
    private const uint CfHdrop = 15;

    private const uint GlobalMoveable = 0x0002;

    /// <summary>
    /// A number that changes whenever the clipboard does.
    ///
    /// Cheap enough to poll, and it changes for content WOLF cannot read as well as content
    /// it can — which is what allows an image to be reported as "an image" rather than
    /// looking like nothing happened.
    /// </summary>
    public static uint SequenceNumber => GetClipboardSequenceNumber();

    /// <summary>What sort of thing is on the clipboard, without opening it.</summary>
    public static ClipboardKind Inspect()
    {
        if (IsClipboardFormatAvailable(CfText)) return ClipboardKind.Text;
        if (IsClipboardFormatAvailable(CfHdrop)) return ClipboardKind.Files;
        if (IsClipboardFormatAvailable(CfBitmap) || IsClipboardFormatAvailable(CfDib)) return ClipboardKind.Image;
        return ClipboardKind.Empty;
    }

    /// <summary>
    /// Read the clipboard as text, or null when it holds none.
    ///
    /// Null covers three cases that do not need distinguishing here: an empty clipboard, one
    /// holding something that is not text, and one another application would not let go of.
    /// </summary>
    public static string? TryReadText(ILogger logger)
    {
        if (!IsClipboardFormatAvailable(CfText)) return null;
        if (!TryOpen()) return null;

        try
        {
            IntPtr handle = GetClipboardData(CfText);
            if (handle == IntPtr.Zero) return null;

            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) return null;

            try
            {
                // The length is bounded by the caller before anything is sent; reading it in
                // full first keeps this function about the clipboard and not about policy.
                return Marshal.PtrToStringUni(pointer);
            }
            finally
            {
                GlobalUnlock(handle);
            }
        }
        catch (Exception ex) when (ex is OutOfMemoryException or ArgumentException)
        {
            // No content in the message: whatever went wrong, the clipboard's contents are
            // not something to write down.
            logger.LogDebug("The clipboard could not be read ({Error}).", ex.GetType().Name);
            return null;
        }
        finally
        {
            CloseClipboard();
        }
    }

    /// <summary>
    /// Replace the clipboard with text. Returns whether Windows accepted it.
    ///
    /// The allocation is handed to the system on success and must not be freed here; freeing
    /// it would leave the clipboard pointing at released memory, which is the sort of bug
    /// that corrupts an unrelated application minutes later.
    /// </summary>
    public static bool TryWriteText(string text, ILogger logger)
    {
        if (!TryOpen()) return false;

        IntPtr block = IntPtr.Zero;

        try
        {
            if (!EmptyClipboard()) return false;

            int bytes = (text.Length + 1) * sizeof(char);
            block = GlobalAlloc(GlobalMoveable, (UIntPtr)bytes);
            if (block == IntPtr.Zero) return false;

            IntPtr pointer = GlobalLock(block);
            if (pointer == IntPtr.Zero) return false;

            try
            {
                Marshal.Copy(text.ToCharArray(), 0, pointer, text.Length);
                Marshal.WriteInt16(pointer, text.Length * sizeof(char), 0);
            }
            finally
            {
                GlobalUnlock(block);
            }

            if (SetClipboardData(CfText, block) == IntPtr.Zero) return false;

            // Ownership transferred. Clearing the local handle is what stops the finally
            // below from freeing memory the clipboard is now pointing at.
            block = IntPtr.Zero;
            return true;
        }
        catch (Exception ex) when (ex is OutOfMemoryException or ArgumentException)
        {
            logger.LogDebug("The clipboard could not be written ({Error}).", ex.GetType().Name);
            return false;
        }
        finally
        {
            if (block != IntPtr.Zero) GlobalFree(block);
            CloseClipboard();
        }
    }

    /// <summary>
    /// Take the clipboard, waiting briefly for whoever else has it.
    ///
    /// Any application may hold the clipboard open for a moment while it copies. Failing on
    /// the first attempt would make clipboard sync unreliable in exactly the situation it is
    /// meant for: somebody actively copying things.
    /// </summary>
    private static bool TryOpen()
    {
        for (int attempt = 0; attempt < OpenAttempts; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero)) return true;
            Thread.Sleep(OpenRetryDelayMs);
        }

        return false;
    }

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool OpenClipboard(IntPtr owner);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseClipboard();

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool EmptyClipboard();

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsClipboardFormatAvailable(uint format);

    [LibraryImport("user32.dll")]
    private static partial IntPtr GetClipboardData(uint format);

    [LibraryImport("user32.dll")]
    private static partial IntPtr SetClipboardData(uint format, IntPtr data);

    [LibraryImport("user32.dll")]
    private static partial uint GetClipboardSequenceNumber();

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GlobalFree(IntPtr handle);

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GlobalLock(IntPtr handle);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GlobalUnlock(IntPtr handle);
}
