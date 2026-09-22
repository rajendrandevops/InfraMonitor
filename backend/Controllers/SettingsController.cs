using InfraMonitor.Api.Data;
using InfraMonitor.Api.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace InfraMonitor.Api.Controllers;

[ApiController]
[Route("api/settings")]
public class SettingsController : ControllerBase
{
    private readonly InfraMonitorDbContext _db;

    public SettingsController(InfraMonitorDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        var settings = await _db.MonitorSettings
            .FirstOrDefaultAsync();

        if (settings == null)
        {
            settings = new MonitorSetting();

            _db.MonitorSettings.Add(settings);

            await _db.SaveChangesAsync();
        }

        return Ok(settings);
    }

    [HttpPut]
    public async Task<IActionResult> Update(
        MonitorSetting updated)
    {
        var settings = await _db.MonitorSettings
            .FirstOrDefaultAsync();

        if (settings == null)
        {
            settings = new MonitorSetting
            {
                Id = 1
            };

            _db.MonitorSettings.Add(settings);
        }

        settings.DefaultPingIntervalSeconds =
            Math.Max(
                1,
                updated.DefaultPingIntervalSeconds);

        settings.PingTimeoutMilliseconds =
            Math.Max(
                100,
                updated.PingTimeoutMilliseconds);

        settings.HistoryRetentionHours =
            Math.Max(
                1,
                updated.HistoryRetentionHours);

        settings.MonitoringEnabled =
            updated.MonitoringEnabled;

        await _db.SaveChangesAsync();

        return Ok(settings);
    }
}