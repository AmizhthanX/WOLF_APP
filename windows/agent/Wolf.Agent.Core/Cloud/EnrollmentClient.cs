using System.Net;
using System.Net.Http.Json;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Identity;

namespace Wolf.Agent.Core.Cloud;

/// <summary>Raised when enrollment cannot proceed, with a cause the installer can show.</summary>
public sealed class EnrollmentException : Exception
{
    public EnrollmentException(string message, string recommendedAction)
        : base(message)
    {
        RecommendedAction = recommendedAction;
    }

    public string RecommendedAction { get; }
}

/// <summary>
/// One-time PC enrollment.
///
/// The key pair is generated here, on this machine, and only the public half is sent. The
/// enrollment token is single-use, supplied by the owner, and never written to disk — if
/// enrollment fails, the operator supplies a fresh token rather than the agent retrying
/// with a stored one.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class EnrollmentClient
{
    private readonly HttpClient _http;
    private readonly ILogger<EnrollmentClient> _logger;

    public EnrollmentClient(HttpClient http, ILogger<EnrollmentClient> logger)
    {
        _http = http;
        _logger = logger;
    }

    private sealed record EnrollRequest(
        [property: JsonPropertyName("enrollmentToken")] string EnrollmentToken,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("hostname")] string Hostname,
        [property: JsonPropertyName("agentVersion")] string AgentVersion,
        [property: JsonPropertyName("publicKey")] string PublicKey);

    private sealed record EnrollResponse(
        [property: JsonPropertyName("pcId")] string PcId,
        [property: JsonPropertyName("name")] string Name);

    private sealed record ProblemResponse(
        [property: JsonPropertyName("error")] ProblemBody? Error);

    private sealed record ProblemBody(
        [property: JsonPropertyName("problem")] string? Problem,
        [property: JsonPropertyName("cause")] string? Cause,
        [property: JsonPropertyName("recommendedAction")] string? RecommendedAction,
        [property: JsonPropertyName("referenceId")] string? ReferenceId);

    /// <summary>Enrol this PC and return the persisted identity.</summary>
    public async Task<PcIdentity> EnrollAsync(
        AgentOptions options,
        PcIdentityStore store,
        string enrollmentToken,
        string agentVersion,
        CancellationToken cancellationToken)
    {
        (ECDsa key, string publicKey) = PcIdentityStore.CreateKeyPair();

        try
        {
            var request = new EnrollRequest(
                enrollmentToken.Trim(),
                options.PcName ?? Environment.MachineName,
                Environment.MachineName,
                agentVersion,
                publicKey);

            var uri = new Uri(new Uri(options.ApiBaseUrl.TrimEnd('/') + "/"), "api/v1/agents/enroll");
            _logger.LogInformation("Enrolling this PC with {Uri}.", uri);

            using HttpResponseMessage response = await _http
                .PostAsJsonAsync(uri, request, cancellationToken)
                .ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                ProblemResponse? problem = null;
                try
                {
                    problem = await response.Content
                        .ReadFromJsonAsync<ProblemResponse>(cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is HttpRequestException or System.Text.Json.JsonException)
                {
                    // The body was not a WOLF problem document; the status code still tells
                    // the operator enough to act.
                }

                string message = problem?.Error?.Problem
                                 ?? $"The WOLF API refused the enrollment ({(int)response.StatusCode}).";
                string action = problem?.Error?.RecommendedAction
                                ?? (response.StatusCode == HttpStatusCode.Unauthorized
                                    ? "Generate a new enrollment token in the WOLF dashboard and try again."
                                    : "Check the API address and network connectivity, then try again.");

                key.Dispose();
                throw new EnrollmentException(message, action);
            }

            EnrollResponse? result = await response.Content
                .ReadFromJsonAsync<EnrollResponse>(cancellationToken)
                .ConfigureAwait(false);

            if (result is null || string.IsNullOrWhiteSpace(result.PcId))
            {
                key.Dispose();
                throw new EnrollmentException(
                    "The WOLF API accepted the enrollment but returned no PC identifier.",
                    "Retry the enrollment. If it keeps happening, check the API logs.");
            }

            // The key is handed to the store, which owns its lifetime from here.
            return store.Save(result.PcId, key, publicKey);
        }
        catch (HttpRequestException ex)
        {
            key.Dispose();
            throw new EnrollmentException(
                $"WOLF could not reach {options.ApiBaseUrl}: {ex.Message}",
                "Check that the PC has internet access and that the API address is correct.");
        }
    }
}
