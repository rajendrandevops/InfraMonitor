using System.Net.NetworkInformation;
using InfraMonitor.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace InfraMonitor.Api.Services;

public class PingService
{
    private readonly IServiceScopeFactory _scopeFactory;

    public PingService(IServiceScopeFactory scopeFactory)
    {
        _scopeFactory = scopeFactory;
    }

    public async Task<PingCheckResult> CheckAsync(
        string ipAddress,
        CancellationToken cancellationToken = default)
    {
        int timeout = await GetConfiguredTimeoutAsync();

        using var ping = new Ping();

        try
        {
            PingReply reply = await ping.SendPingAsync(
                ipAddress,
                timeout);

            if (reply.Status == IPStatus.Success)
            {
                return new PingCheckResult(
                    true,
                    reply.RoundtripTime,
                    null);
            }

            return new PingCheckResult(
                false,
                null,
                reply.Status.ToString());
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new PingCheckResult(
                false,
                null,
                ex.Message);
        }
    }

    private async Task<int> GetConfiguredTimeoutAsync()
    {
        using var scope = _scopeFactory.CreateScope();

        var db = scope.ServiceProvider
            .GetRequiredService<InfraMonitorDbContext>();

        var settings = await db.MonitorSettings
            .AsNoTracking()
            .OrderBy(s => s.Id)
            .FirstOrDefaultAsync();

        return settings?.PingTimeoutMilliseconds ?? 2000;
    }
}

public record PingCheckResult(
    bool IsUp,
    long? LatencyMs,
    string? ErrorMessage);