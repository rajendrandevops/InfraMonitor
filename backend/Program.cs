using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using InfraMonitor.Api.Data;
using InfraMonitor.Api.Models;
using InfraMonitor.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;

string dataDirectory = GetDataDirectory();
Directory.CreateDirectory(dataDirectory);
string portFile = Path.Combine(dataDirectory, "runtime.port");

var singleInstance = new Mutex(
    true,
    "Global\\InfraMonitorSingleInstance",
    out bool createdNew);

if (!createdNew)
{
    OpenExistingInstance(portFile);
    return;
}

AppDomain.CurrentDomain.ProcessExit += (_, _) => singleInstance.ReleaseMutex();

var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
{
    ["ConnectionStrings:DefaultConnection"] = $"Data Source={Path.Combine(dataDirectory, "inframonitor.db")}" 
});

int configuredPort = GetAvailablePort(builder.Configuration);
var httpUrl = $"http://127.0.0.1:{configuredPort}";

builder.WebHost.UseUrls(httpUrl);

builder.Services.AddControllers();

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddDbContext<InfraMonitorDbContext>(
    options =>
    {
        options.UseSqlite(
            builder.Configuration.GetConnectionString(
                "DefaultConnection"));
    });

builder.Services.AddSingleton<PingService>();
builder.Services.AddSingleton<MonitoringService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MonitoringService>());

builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
    {
        policy
            .AllowAnyOrigin()
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

var app = builder.Build();

var webRootPath = string.IsNullOrWhiteSpace(builder.Environment.WebRootPath)
    ? Path.Combine(AppContext.BaseDirectory, "wwwroot")
    : builder.Environment.WebRootPath;

if (!Directory.Exists(webRootPath))
{
    webRootPath = Path.Combine(builder.Environment.ContentRootPath, "wwwroot");
}

var staticFileProvider = new PhysicalFileProvider(webRootPath);

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = staticFileProvider,
    RequestPath = ""
});

app.UseDefaultFiles(new DefaultFilesOptions
{
    FileProvider = staticFileProvider,
    RequestPath = ""
});

app.UseCors("Frontend");

app.UseSwagger();
app.UseSwaggerUI();

app.MapControllers();

app.MapGet("/", async context =>
{
    var indexPath = Path.Combine(webRootPath, "index.html");
    if (File.Exists(indexPath))
    {
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.SendFileAsync(indexPath);
        return;
    }

    context.Response.StatusCode = StatusCodes.Status404NotFound;
    await context.Response.WriteAsync("index.html not found");
});

app.MapFallback(async context =>
{
    var fallbackPath = Path.Combine(webRootPath, "index.html");
    if (File.Exists(fallbackPath))
    {
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.SendFileAsync(fallbackPath);
        return;
    }

    context.Response.StatusCode = StatusCodes.Status404NotFound;
    await context.Response.WriteAsync("index.html not found");
});

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider
        .GetRequiredService<InfraMonitorDbContext>();

    await db.Database.EnsureCreatedAsync();
    await EnsureProductionDatabaseStateAsync(db);
}

app.Lifetime.ApplicationStarted.Register(() =>
{
    File.WriteAllText(portFile, configuredPort.ToString());
    _ = LaunchBrowserWhenReadyAsync(httpUrl);
});

await app.RunAsync();

static async Task EnsureProductionDatabaseStateAsync(InfraMonitorDbContext db)
{
    var dbPath = GetDatabasePath();
    BackupDatabaseIfNeeded(dbPath);

    if (!await db.MonitorSettings.AnyAsync())
    {
        db.MonitorSettings.Add(
            new MonitorSetting
            {
                Id = 1,
                DefaultPingIntervalSeconds = 5,
                PingTimeoutMilliseconds = 2000,
                HistoryRetentionHours = 72,
                MonitoringEnabled = true
            });

        await db.SaveChangesAsync();
    }

    if (await db.Devices.AnyAsync())
    {
        return;
    }

    var seededNames = new[]
    {
        "Servers",
        "Network",
        "Firewall",
        "WAN"
    };

    var defaultGroups = await db.DeviceGroups
        .Where(g => seededNames.Contains(g.Name))
        .ToListAsync();

    if (defaultGroups.Count > 0)
    {
        db.DeviceGroups.RemoveRange(defaultGroups);
        await db.SaveChangesAsync();
    }
}

static string GetDatabasePath()
{
    return Path.Combine(GetDataDirectory(), "inframonitor.db");
}

static string GetDataDirectory()
{
    string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    return Path.Combine(localAppData, "InfraMonitor");
}

static void OpenExistingInstance(string portFile)
{
    try
    {
        if (File.Exists(portFile) && int.TryParse(File.ReadAllText(portFile), out int port))
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = $"http://127.0.0.1:{port}",
                UseShellExecute = true
            });
        }
    }
    catch
    {
        // A second launch must never create another monitoring process.
    }
}

static async Task LaunchBrowserWhenReadyAsync(string url)
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    for (int attempt = 0; attempt < 20; attempt++)
    {
        try
        {
            using var response = await client.GetAsync(url);
            if (response.IsSuccessStatusCode)
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
                return;
            }
        }
        catch
        {
            // The listener may need another short interval to become ready.
        }

        await Task.Delay(250);
    }
}

static void BackupDatabaseIfNeeded(string databasePath)
{
    if (!File.Exists(databasePath)) return;

    var directory = Path.GetDirectoryName(databasePath);
    if (string.IsNullOrWhiteSpace(directory)) return;

    var backupDirectory = Path.Combine(directory, "backup-before-agent");
    Directory.CreateDirectory(backupDirectory);

    var backupFile = Path.Combine(
        backupDirectory,
        $"inframonitor-backup-{DateTime.UtcNow:yyyyMMdd-HHmmss}.db");

    if (!File.Exists(backupFile))
    {
        File.Copy(databasePath, backupFile, overwrite: false);
    }
}

static int GetAvailablePort(ConfigurationManager configuration)
{
    int preferredPort = configuration.GetValue<int?>("InfraMonitor:Port") ??
        configuration.GetValue<int?>("Port") ??
        5041;

    var envPort = Environment.GetEnvironmentVariable("INFRA_MONITOR_PORT");
    if (!string.IsNullOrWhiteSpace(envPort) && int.TryParse(envPort, out int parsedEnvPort))
    {
        preferredPort = parsedEnvPort;
    }

    var candidatePorts = new SortedSet<int> { preferredPort };
    for (int offset = 1; offset < 50; offset++)
    {
        candidatePorts.Add(preferredPort + offset);
    }

    foreach (int port in candidatePorts)
    {
        if (IsPortAvailable(port))
        {
            return port;
        }
    }

    throw new InvalidOperationException("No available localhost port found for InfraMonitor.");
}

static bool IsPortAvailable(int port)
{
    try
    {
        using var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        return true;
    }
    catch
    {
        return false;
    }
}