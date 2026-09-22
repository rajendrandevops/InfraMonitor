using InfraMonitor.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace InfraMonitor.Api.Controllers;

[ApiController]
[Route("api/alerts")]
public class AlertsController : ControllerBase
{
    private readonly InfraMonitorDbContext _db;

    public AlertsController(InfraMonitorDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    public async Task<IActionResult> GetAlerts(
        [FromQuery] int limit = 100)
    {
        limit = Math.Clamp(limit, 1, 500);

        var alerts = await _db.Alerts
            .Include(a => a.Device)
                .ThenInclude(d => d!.Group)
            .OrderByDescending(a => a.CreatedAt)
            .Take(limit)
            .AsNoTracking()
            .Select(a => new
            {
                a.Id,
                a.DeviceId,
                Device = a.Device!.Name,
                IpAddress = a.Device.IpAddress,
                Group = a.Device.Group!.Name,
                a.EventType,
                a.Message,
                a.IsAcknowledged,
                a.CreatedAt
            })
            .ToListAsync();

        return Ok(alerts);
    }

    [HttpGet("count")]
    public async Task<IActionResult> GetCount()
    {
        int count = await _db.Alerts
            .CountAsync(a => !a.IsAcknowledged);

        return Ok(new { count });
    }

    [HttpPatch("{id:int}/acknowledge")]
    public async Task<IActionResult> Acknowledge(int id)
    {
        var alert = await _db.Alerts
            .FindAsync(id);

        if (alert == null)
            return NotFound();

        alert.IsAcknowledged = true;

        await _db.SaveChangesAsync();

        return NoContent();
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var alert = await _db.Alerts
            .FindAsync(id);

        if (alert == null)
            return NotFound();

        _db.Alerts.Remove(alert);

        await _db.SaveChangesAsync();

        return NoContent();
    }

    [HttpDelete]
    public async Task<IActionResult> Clear()
    {
        await _db.Alerts.ExecuteDeleteAsync();

        return NoContent();
    }
}