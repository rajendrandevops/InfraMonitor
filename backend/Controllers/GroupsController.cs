using InfraMonitor.Api.Data;
using InfraMonitor.Api.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace InfraMonitor.Api.Controllers;

[ApiController]
[Route("api/groups")]
public class GroupsController : ControllerBase
{
    private readonly InfraMonitorDbContext _db;

    public GroupsController(InfraMonitorDbContext db)
    {
        _db = db;
    }

    // GET: api/groups
    [HttpGet]
    public async Task<IActionResult> GetGroups()
    {
        var groups = await _db.DeviceGroups
            .AsNoTracking()
            .OrderBy(g => g.Name)
            .Select(g => new
            {
                g.Id,
                g.Name,
                g.Description,
                DeviceCount = g.Devices.Count
            })
            .ToListAsync();

        return Ok(groups);
    }

    // GET: api/groups/1
    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetGroup(int id)
    {
        var group = await _db.DeviceGroups
            .Include(g => g.Devices)
            .AsNoTracking()
            .FirstOrDefaultAsync(g => g.Id == id);

        if (group == null)
            return NotFound();

        return Ok(group);
    }

    // POST: api/groups
    [HttpPost]
    public async Task<IActionResult> CreateGroup(
        [FromBody] DeviceGroup group)
    {
        if (string.IsNullOrWhiteSpace(group.Name))
            return BadRequest("Group name is required.");

        string name = group.Name.Trim();

        bool exists = await _db.DeviceGroups
            .AnyAsync(g =>
                g.Name.ToLower() == name.ToLower());

        if (exists)
            return Conflict("A group with this name already exists.");

        var newGroup = new DeviceGroup
        {
            Name = name,
            Description =
                string.IsNullOrWhiteSpace(group.Description)
                    ? null
                    : group.Description.Trim()
        };

        _db.DeviceGroups.Add(newGroup);

        await _db.SaveChangesAsync();

        return CreatedAtAction(
            nameof(GetGroup),
            new { id = newGroup.Id },
            newGroup);
    }

    // PUT: api/groups/1
    [HttpPut("{id:int}")]
    public async Task<IActionResult> UpdateGroup(
        int id,
        [FromBody] DeviceGroup updated)
    {
        var group = await _db.DeviceGroups
            .FindAsync(id);

        if (group == null)
            return NotFound();

        if (string.IsNullOrWhiteSpace(updated.Name))
            return BadRequest("Group name is required.");

        string name = updated.Name.Trim();

        bool duplicate = await _db.DeviceGroups
            .AnyAsync(g =>
                g.Id != id &&
                g.Name.ToLower() == name.ToLower());

        if (duplicate)
            return Conflict(
                "Another group already uses this name.");

        group.Name = name;

        group.Description =
            string.IsNullOrWhiteSpace(
                updated.Description)
                ? null
                : updated.Description.Trim();

        await _db.SaveChangesAsync();

        return Ok(new
        {
            group.Id,
            group.Name,
            group.Description
        });
    }

    // DELETE: api/groups/1
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> DeleteGroup(int id)
    {
        var group = await _db.DeviceGroups
            .Include(g => g.Devices)
            .FirstOrDefaultAsync(g => g.Id == id);

        if (group == null)
            return NotFound();

        if (group.Devices.Any())
        {
            return Conflict(
                "Cannot delete a group containing devices. " +
                "Move or delete its devices first.");
        }

        _db.DeviceGroups.Remove(group);

        await _db.SaveChangesAsync();

        return NoContent();
    }
}