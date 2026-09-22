using InfraMonitor.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace InfraMonitor.Api.Controllers;

[ApiController]
[Route("api/monitoring")]
public class MonitoringController : ControllerBase
{
    private readonly InfraMonitorDbContext _db;

    public MonitoringController(
        InfraMonitorDbContext db)
    {
        _db = db;
    }

    [HttpGet("summary")]
    public async Task<IActionResult> GetSummary()
    {
        int total =
            await _db.Devices
                .CountAsync(d => d.Enabled);

        int up =
            await _db.Devices
                .CountAsync(
                    d => d.Enabled && d.IsUp);

        int down =
            await _db.Devices
                .CountAsync(
                    d => d.Enabled && !d.IsUp);

        double? averageLatency =
            await _db.Devices
                .Where(d =>
                    d.Enabled &&
                    d.IsUp &&
                    d.LastLatencyMs.HasValue)
                .Select(d =>
                    (double?)d.LastLatencyMs)
                .AverageAsync();

        return Ok(new
        {
            total,
            up,
            down,
            averageLatencyMs =
                averageLatency.HasValue
                    ? Math.Round(
                        averageLatency.Value,
                        1)
                    : 0,
            monitoring = true,
            timestamp = DateTime.UtcNow
        });
    }

    [HttpGet("status")]
    public async Task<IActionResult> GetStatus()
    {
        var devices =
            await _db.Devices
                .Include(d => d.Group)
                .Where(d => d.Enabled)
                .AsNoTracking()
                .OrderBy(d => d.GroupId)
                .ThenBy(d => d.Name)
                .Select(d => new
                {
                    d.Id,
                    d.Name,
                    d.IpAddress,
                    d.GroupId,
                    Group =
                        d.Group!.Name,
                    d.IsUp,
                    d.LastLatencyMs,
                    d.LastChecked,
                    d.LastSeen,
                    d.LastError,
                    d.PingIntervalSeconds
                })
                .ToListAsync();

        return Ok(devices);
    }

    [HttpGet("history/{deviceId:int}")]
    public async Task<IActionResult> GetHistory(
        int deviceId,
        [FromQuery] int hours = 24)
    {
        hours =
            Math.Clamp(
                hours,
                1,
                720);

        DateTime from =
            DateTime.UtcNow
                .AddHours(-hours);

        var history =
            await _db.PingResults
                .Where(p =>
                    p.DeviceId == deviceId &&
                    p.CheckedAt >= from)
                .OrderBy(p => p.CheckedAt)
                .AsNoTracking()
                .Select(p => new
                {
                    p.Id,
                    p.DeviceId,
                    p.IsUp,
                    p.LatencyMs,
                    p.CheckedAt,
                    p.ErrorMessage
                })
                .ToListAsync();

        return Ok(history);
    }
}