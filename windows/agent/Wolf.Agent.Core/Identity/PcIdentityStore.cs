using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.Core.Identity;

/// <summary>The PC's enrolled identity: who it is to the cloud, and the key that proves it.</summary>
public sealed record PcIdentity(string PcId, string PublicKey)
{
    /// <summary>Never serialized to the cloud, never logged. Lives only in memory and DPAPI storage.</summary>
    public required ECDsa Key { get; init; }
}

/// <summary>
/// Storage for the PC identity.
///
/// The private key is generated on this machine and never leaves it. At rest it is
/// protected with DPAPI scoped to the local machine, so the file is unusable if copied to
/// another PC, and the containing directory is ACL'd to SYSTEM and Administrators so a
/// standard user cannot read it.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class PcIdentityStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("WOLF.PcIdentity.v1");

    private readonly string _path;
    private readonly ILogger<PcIdentityStore> _logger;

    public PcIdentityStore(string path, ILogger<PcIdentityStore> logger)
    {
        _path = path;
        _logger = logger;
    }

    private sealed record StoredIdentity(string PcId, string PublicKey, string PrivateKey);

    /// <summary>Load the enrolled identity, or null when this PC has not been enrolled yet.</summary>
    public PcIdentity? Load()
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        try
        {
            byte[] protectedBytes = File.ReadAllBytes(_path);
            byte[] plaintext = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.LocalMachine);

            StoredIdentity? stored;
            try
            {
                stored = JsonSerializer.Deserialize<StoredIdentity>(plaintext);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }

            if (stored is null)
            {
                _logger.LogError("The stored WOLF identity could not be read; re-enrollment is required.");
                return null;
            }

            ECDsa key = ECDsa.Create();
            key.ImportPkcs8PrivateKey(Base64Url.Decode(stored.PrivateKey), out _);
            return new PcIdentity(stored.PcId, stored.PublicKey) { Key = key };
        }
        catch (CryptographicException ex)
        {
            // A DPAPI failure means the file was copied from another machine or the machine
            // key changed. Either way the identity is unusable and must not be silently
            // replaced: re-enrollment is an explicit, audited act.
            _logger.LogError(ex, "The stored WOLF identity could not be decrypted on this machine.");
            return null;
        }
    }

    /// <summary>Create a new key pair. The private key exists only in memory until <see cref="Save"/>.</summary>
    public static (ECDsa Key, string PublicKey) CreateKeyPair()
    {
        ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        string publicKey = Base64Url.Encode(key.ExportSubjectPublicKeyInfo());
        return (key, publicKey);
    }

    /// <summary>Persist an enrolled identity, protected for this machine only.</summary>
    public PcIdentity Save(string pcId, ECDsa key, string publicKey)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        RestrictDirectoryAccess(Path.GetDirectoryName(_path)!);

        byte[] pkcs8 = key.ExportPkcs8PrivateKey();
        try
        {
            var stored = new StoredIdentity(pcId, publicKey, Base64Url.Encode(pkcs8));
            byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(stored);
            try
            {
                byte[] protectedBytes = ProtectedData.Protect(
                    plaintext,
                    Entropy,
                    DataProtectionScope.LocalMachine);

                // Write to a temporary file and move: a torn write must never leave the
                // agent with half an identity.
                string temporary = _path + ".tmp";
                File.WriteAllBytes(temporary, protectedBytes);
                File.Move(temporary, _path, overwrite: true);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(pkcs8);
        }

        _logger.LogInformation("Stored the WOLF PC identity for {PcId}.", pcId);
        return new PcIdentity(pcId, publicKey) { Key = key };
    }

    /// <summary>Remove the stored identity. Used when the PC is revoked or uninstalled.</summary>
    public void Clear()
    {
        if (File.Exists(_path))
        {
            File.Delete(_path);
        }
    }

    /// <summary>
    /// Restrict the data directory to SYSTEM and Administrators. Without this the identity
    /// blob would be readable by any local user, and while DPAPI machine scope means they
    /// could also decrypt it, there is no reason to hand it to them.
    /// </summary>
    /// <summary>
    /// Lock the directory down to SYSTEM, Administrators, and whoever is running the agent.
    ///
    /// The third one is not a concession. Inheritance is switched off here, so a rule set of
    /// SYSTEM and Administrators alone locks the agent out of the directory it just created
    /// unless it happens to be one of them — and enrolment then fails on the next line with
    /// an access-denied error. In production the agent is LocalSystem and the extra rule is
    /// a duplicate that changes nothing. Anywhere else — the documented development run, or
    /// the agent started by hand — it is the difference between working and not.
    ///
    /// It gives away nothing either: a user who can run this process can already read its
    /// memory, where the same key is sitting unprotected. The file stays DPAPI-protected to
    /// this machine regardless, so copying it elsewhere still yields nothing.
    /// </summary>
    private static void RestrictDirectoryAccess(string directory)
    {
        var info = new DirectoryInfo(directory);
        DirectorySecurity security = info.GetAccessControl();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

        using var current = WindowsIdentity.GetCurrent();
        SecurityIdentifier[] allowed = current.User is { } account && account != system
            ? new[] { system, administrators, account }
            : new[] { system, administrators };

        foreach (SecurityIdentifier identity in allowed)
        {
            security.AddAccessRule(new FileSystemAccessRule(
                identity,
                FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        }

        info.SetAccessControl(security);
    }
}

/// <summary>base64url encoding, matching the cloud's key and signature encoding.</summary>
public static class Base64Url
{
    public static string Encode(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] Decode(string value)
    {
        string padded = value.Replace('-', '+').Replace('_', '/');
        int remainder = padded.Length % 4;
        if (remainder == 2)
        {
            padded += "==";
        }
        else if (remainder == 3)
        {
            padded += "=";
        }
        else if (remainder == 1)
        {
            throw new FormatException("Invalid base64url value.");
        }

        return Convert.FromBase64String(padded);
    }
}
