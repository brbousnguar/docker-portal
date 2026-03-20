const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3200);
const APP_NAME = process.env.APP_NAME || "portal-brahim";
const DOCKER_SOCKET_PATH =
  process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
const STATIC_DIR = path.join(__dirname, "public");

const HTTP_PORT_HINTS = new Set([
  80,
  3000,
  3001,
  4173,
  4200,
  5000,
  5173,
  8000,
  8008,
  8080,
  8081,
  8787,
  8888,
  9000,
]);

function dockerRequest(method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path: requestPath,
        method,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Docker API request failed with ${response.statusCode}: ${body}`,
              ),
            );
            return;
          }

          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

function normalizeName(rawName) {
  return String(rawName || "").replace(/^\/+/, "");
}

function titleize(name) {
  return normalizeName(name)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isLikelyWebPort(portBinding) {
  const privatePort = Number(portBinding.PrivatePort);
  const publicPort = Number(portBinding.PublicPort);
  if (portBinding.Type !== "tcp" || !publicPort) {
    return false;
  }

  return (
    HTTP_PORT_HINTS.has(privatePort) ||
    HTTP_PORT_HINTS.has(publicPort) ||
    (publicPort >= 3000 && publicPort <= 9999)
  );
}

function toAppRecord(container) {
  const labels = container.Labels || {};
  const names = container.Names || [];
  const primaryName = normalizeName(names[0] || container.Names?.[0] || container.Id);
  const projectName = labels["com.docker.compose.project"] || null;
  const serviceName = labels["com.docker.compose.service"] || null;

  const isExcluded = 
    primaryName.includes(APP_NAME) ||
    container.Image?.includes(APP_NAME) ||
    serviceName === APP_NAME ||
    /backend|api|db|database|postgres|mysql|redis/i.test(serviceName || primaryName);

  if (isExcluded) {
    return [];
  }

  const ports = Array.from(
    new Map(
      (container.Ports || [])
        .filter(isLikelyWebPort)
        .map((portBinding) => {
          const key = [
            portBinding.PublicPort,
            portBinding.PrivatePort,
            portBinding.Type,
          ].join(":");

          return [
            key,
            {
              ip: portBinding.IP || "0.0.0.0",
              privatePort: portBinding.PrivatePort,
              publicPort: portBinding.PublicPort,
              type: portBinding.Type,
              url: `http://localhost:${portBinding.PublicPort}`,
            },
          ];
        }),
    ).values(),
  ).sort((left, right) => left.publicPort - right.publicPort);

  if (ports.length === 0) {
    return [];
  }

  return ports.map((portBinding, index) => ({
    id: `${container.Id}:${portBinding.publicPort}:${index}`,
    rawContainerId: container.Id,
    name: titleize(
      projectName && /^(web|frontend|backend|api|app|client|server|db|database)$/i.test(serviceName)
        ? `${projectName} ${serviceName}`
        : serviceName || primaryName
    ),
    containerName: primaryName,
    image: container.Image,
    project: projectName,
    service: serviceName,
    status: container.Status,
    state: container.State,
    port: portBinding.publicPort,
    internalPort: portBinding.privatePort,
    protocol: portBinding.type,
    url: portBinding.url,
  }));
}

async function listApps() {
  const containers = await dockerRequest("GET", "/containers/json");
  const filteredApps = containers.flatMap(toAppRecord);

  const uniqueContainerIds = [...new Set(filteredApps.map((a) => a.rawContainerId))];
  const statsPromises = uniqueContainerIds.map(async (cid) => {
    try {
      const stats = await dockerRequest("GET", `/containers/${cid}/stats?stream=false`);
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      let cpuPercent = 0.0;
      if (systemDelta > 0.0 && cpuDelta > 0.0) {
        cpuPercent = (cpuDelta / systemDelta) * (stats.cpu_stats.online_cpus || 1) * 100.0;
      }
      
      const memUsage = stats.memory_stats.usage || 0;
      const formatBytes = (bytes) => {
        if (bytes === 0) return "0 MB";
        return (bytes / 1024 / 1024).toFixed(1) + " MB";
      };

      return { cid, cpu: `${cpuPercent.toFixed(1)}%`, ram: formatBytes(memUsage) };
    } catch (e) {
      return { cid, cpu: "N/A", ram: "N/A" };
    }
  });

  const statsResults = await Promise.all(statsPromises);
  const statsMap = Object.fromEntries(statsResults.map((s) => [s.cid, s]));

  return filteredApps
    .map((app) => {
      const { rawContainerId, ...rest } = app;
      return {
        ...rest,
        cpu: statsMap[rawContainerId]?.cpu || "N/A",
        ram: statsMap[rawContainerId]?.ram || "N/A",
      };
    })
    .sort((left, right) => {
      if (left.project && right.project && left.project !== right.project) {
        return left.project.localeCompare(right.project);
      }

      if (left.name !== right.name) {
        return left.name.localeCompare(right.name);
      }

      return left.port - right.port;
    });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendFile(response, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const extension = path.extname(filePath);
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
      }[extension] || "application/octet-stream";

    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const parsedUrl = new URL(request.url, `http://${request.headers.host}`);

  if (parsedUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, app: APP_NAME });
    return;
  }

  if (parsedUrl.pathname === "/api/apps") {
    try {
      const apps = await listApps();
      sendJson(response, 200, {
        app: APP_NAME,
        generatedAt: new Date().toISOString(),
        total: apps.length,
        apps,
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "Failed to read Docker containers",
        details: error.message,
      });
    }
    return;
  }

  const requestedPath =
    parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(STATIC_DIR, safePath);

  if (!filePath.startsWith(STATIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  sendFile(response, filePath);
});

server.listen(PORT, () => {
  console.log(`${APP_NAME} listening on http://localhost:${PORT}`);
});
