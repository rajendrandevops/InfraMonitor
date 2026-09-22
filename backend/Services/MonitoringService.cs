using InfraMonitor.Api.Data;
using InfraMonitor.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace InfraMonitor.Api.Services;

public class MonitoringService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<MonitoringService> _logger;

    public MonitoringService(
        IServiceScopeFactory scopeFactory,
        ILogger<MonitoringService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task CheckDeviceNowAsync(
        int deviceId,
        CancellationToken cancellationToken = default)
    {
        using IServiceScope scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<InfraMonitorDbContext>();
        var pingService = scope.ServiceProvider.GetRequiredService<PingService>();
        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId, cancellationToken);

        if (device == null || !device.Enabled)
        {
            return;
        }

        var settings = await db.MonitorSettings.AsNoTracking().FirstOrDefaultAsync(cancellationToken);
        await MonitorDeviceAsync(db, pingService, device, settings, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(
        CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "InfraMonitor monitoring engine started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await MonitorDevicesAsync(
                    stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Monitoring cycle failed.");
            }

            try
            {
                await Task.Delay(
                    TimeSpan.FromSeconds(1),
                    stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        _logger.LogInformation(
            "InfraMonitor monitoring engine stopped.");
    }

    private async Task MonitorDevicesAsync(
        CancellationToken cancellationToken)
    {
        using IServiceScope scope =
            _scopeFactory.CreateScope();

        var db =
            scope.ServiceProvider
                .GetRequiredService<
                    InfraMonitorDbContext>();

        var pingService =
            scope.ServiceProvider
                .GetRequiredService<PingService>();

        var settings =
            await db.MonitorSettings
                .AsNoTracking()
                .FirstOrDefaultAsync(
                    cancellationToken);

        if (settings != null &&
            !settings.MonitoringEnabled)
        {
            return;
        }

        List<Device> devices =
            await db.Devices
                .Where(d => d.Enabled)
                .ToListAsync(
                    cancellationToken);

        DateTime now =
            DateTime.UtcNow;

        foreach (Device device in devices)
        {
            if (cancellationToken.IsCancellationRequested)
                break;

            if (device.NextCheckAt.HasValue &&
                device.NextCheckAt.Value > now)
            {
                continue;
            }

            try
            {
                await MonitorDeviceAsync(db, pingService, device, settings, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Failed to monitor {Device} ({IP})",
                    device.Name,
                    device.IpAddress);
            }
        }

        // --------------------------------------------
        // Save monitoring state + history + alerts
        // --------------------------------------------

        await db.SaveChangesAsync(
            cancellationToken);

        // --------------------------------------------
        // History retention
        // --------------------------------------------

        if (settings != null &&
            settings.HistoryRetentionHours > 0)
        {
            DateTime historyCutoff =
                DateTime.UtcNow.AddHours(
                    -settings.HistoryRetentionHours);

            await db.PingResults
                .Where(p =>
                    p.CheckedAt <
                    historyCutoff)
                .ExecuteDeleteAsync(
                    cancellationToken);
        }
    }

    private async Task MonitorDeviceAsync(
        InfraMonitorDbContext db,
        PingService pingService,
        Device device,
        MonitorSetting? settings,
        CancellationToken cancellationToken)
    {
        bool firstCheck = device.LastChecked == null;
        bool previousStatus = device.IsUp;
        var result = await pingService.CheckAsync(device.IpAddress, cancellationToken);
        DateTime checkTime = DateTime.UtcNow;

        device.IsUp = result.IsUp;
        device.LastLatencyMs = result.LatencyMs;
        device.LastChecked = checkTime;
        device.LastError = result.ErrorMessage;
        if (result.IsUp) device.LastSeen = checkTime;
        device.NextCheckAt = checkTime.AddSeconds(Math.Max(1, device.PingIntervalSeconds));

        db.PingResults.Add(new PingResult
        {
            DeviceId = device.Id,
            IsUp = result.IsUp,
            LatencyMs = result.LatencyMs,
            CheckedAt = checkTime,
            ErrorMessage = result.ErrorMessage
        });

        if (firstCheck || previousStatus == result.IsUp) return;

        db.Alerts.Add(new Alert
        {
            DeviceId = device.Id,
            EventType = result.IsUp ? "RECOVERY" : "DOWN",
            Message = result.IsUp
                ? $"Device {device.Name} ({device.IpAddress}) recovered."
                : $"Device {device.Name} ({device.IpAddress}) is DOWN.",
            IsAcknowledged = false,
            CreatedAt = checkTime
        });
    }
}