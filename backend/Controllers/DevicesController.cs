using InfraMonitor.Api.Data;
using InfraMonitor.Api.Models;
using InfraMonitor.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Net;

namespace InfraMonitor.Api.Controllers;

[ApiController]
[Route("api/devices")]
public class DevicesController : ControllerBase
{
    private readonly InfraMonitorDbContext _db;
    private readonly MonitoringService _monitoringService;

    public DevicesController(
        InfraMonitorDbContext db,
        MonitoringService monitoringService)
    {
        _db = db;
        _monitoringService = monitoringService;
    }

    [HttpGet]
    public async Task<IActionResult> GetDevices()
    {
        var devices = await _db.Devices
            .Include(d => d.Group)
            .AsNoTracking()
            .OrderBy(d => d.GroupId)
            .ThenBy(d => d.Name)
            .Select(d => new
            {
                d.Id,
                d.Name,
                d.IpAddress,
                d.GroupId,
                Group = d.Group!.Name,
                d.PingIntervalSeconds,
                d.Enabled,
                d.IsUp,
                d.LastLatencyMs,
                d.LastChecked,
                d.LastSeen,
                d.LastError
            })
            .ToListAsync();

        return Ok(devices);
    }

    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetDevice(int id)
    {
        var device = await _db.Devices
            .Include(d => d.Group)
            .AsNoTracking()
            .Where(d => d.Id == id)
            .Select(d => new
            {
                d.Id,
                d.Name,
                d.IpAddress,
                d.GroupId,
                Group = d.Group!.Name,
                d.PingIntervalSeconds,
                d.Enabled,
                d.IsUp,
                d.LastLatencyMs,
                d.LastChecked,
                d.LastSeen,
                d.LastError
            })
            .FirstOrDefaultAsync();

        if (device == null)
            return NotFound();

        return Ok(device);
    }

    [HttpPost]
    public async Task<IActionResult> CreateDevice(
        Device device)
    {
        if (string.IsNullOrWhiteSpace(device.Name))
            return BadRequest("Device name is required.");

        if (!IPAddress.TryParse(
            device.IpAddress,
            out var parsedAddress) ||
            parsedAddress.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return BadRequest(
            "A valid IPv4 address is required.");
        }

        bool groupExists = await _db.DeviceGroups
            .AnyAsync(g => g.Id == device.GroupId);

        if (!groupExists)
            return BadRequest("Invalid group.");

        if (device.PingIntervalSeconds < 1)
            device.PingIntervalSeconds = 5;

        device.Id = 0;
        device.IsUp = false;
        device.LastLatencyMs = null;
        device.LastChecked = null;
        device.LastSeen = null;
        device.LastError = null;
        device.NextCheckAt = DateTime.UtcNow;

        _db.Devices.Add(device);

        await _db.SaveChangesAsync();

        await _monitoringService.CheckDeviceNowAsync(device.Id);

        return CreatedAtAction(
            nameof(GetDevice),
            new { id = device.Id },
            device);
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> UpdateDevice(
        int id,
        Device updated)
    {
        var device = await _db.Devices
            .FindAsync(id);

        if (device == null)
            return NotFound();

        if (string.IsNullOrWhiteSpace(updated.Name))
            return BadRequest("Device name is required.");

        if (!IPAddress.TryParse(
            updated.IpAddress,
            out var parsedAddress) ||
            parsedAddress.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return BadRequest(
            "A valid IPv4 address is required.");
        }

        bool groupExists = await _db.DeviceGroups
            .AnyAsync(g => g.Id == updated.GroupId);

        if (!groupExists)
            return BadRequest("Invalid group.");

        device.Name = updated.Name;
        device.IpAddress = updated.IpAddress;
        device.GroupId = updated.GroupId;
        device.PingIntervalSeconds =
            Math.Max(1, updated.PingIntervalSeconds);
        device.Enabled = updated.Enabled;

        device.NextCheckAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        return NoContent();
    }

    [HttpPatch("{id:int}/enabled")]
    public async Task<IActionResult> SetEnabled(
        int id,
        [FromBody] bool enabled)
    {
        var device = await _db.Devices
            .FindAsync(id);

        if (device == null)
            return NotFound();

        device.Enabled = enabled;

        if (enabled)
            device.NextCheckAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        return Ok(new
        {
            device.Id,
            device.Enabled
        });
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> DeleteDevice(int id)
    {
        var device = await _db.Devices
            .FindAsync(id);

        if (device == null)
            return NotFound();

        await _db.Alerts
            .Where(alert => alert.DeviceId == id)
            .ExecuteDeleteAsync();

        await _db.PingResults
            .Where(result => result.DeviceId == id)
            .ExecuteDeleteAsync();

        _db.Devices.Remove(device);

        await _db.SaveChangesAsync();

        return NoContent();
    }
}