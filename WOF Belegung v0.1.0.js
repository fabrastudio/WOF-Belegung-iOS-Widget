// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: purple; icon-glyph: dumbbell;

/*
Dieses Skript erstellt ein Scriptable-Widget für die Belegungsanzeige der WOF Fitnessstudios.
Hauptfunktionen:
- Abrufen der aktuellen Belegungsdaten von der WOF-Website
- Anzeigen der aktuellen Belegung in Prozent
- Offline-Modus mit Caching für Zeiten ohne Internetverbindung
- Farbkodierung der Belegungsanzeige basierend auf dem Prozentsatz
- Anzeige des Aktualisierungszeitpunkts 
*/

// Konfiguration
const config = {
  enableOfflineMode: true, // Offline-Modus aktivieren oder deaktivieren  
  enableColorCoding: true, // Farbkodierung der Belegungsanzeige
  enableTimestamp: true, // Zeitstempel anzeigen 
  defaultStudioNumber: 1, // Standard-Studio wenn kein Parameter gesetzt ist
  runsInWidget: true // Widget-Modus aktivieren oder deaktivieren 
};

// Prüfen, ob das Skript im Widget läuft
config.runsInWidget = args.runsInWidget !== undefined ? args.runsInWidget : true;

// Konstanten
const CONSTANTS = {
  URL: 'https://app.wof.de/besucher/',
  CACHE_MAX_AGE_MINUTES: 60, // Cache-Alter in Minuten
  UPDATE_INTERVAL_MINUTES: 15, // Cache-Aktualisierung in Minuten
  CACHE_CLEANUP_INTERVAL_HOURS: 24, // Cache-Bereinigung in Stunden
  MAX_CACHE_AGE_DAYS: 7 // Cache-Alter in Tagen
};

// Widget-Parameter verarbeiten
function getStudioNumbers() {
  let studioNumbers = [config.defaultStudioNumber];
  
  if (args.widgetParameter) {
    // Prüfen, ob mehrere Studios durch Semikolon getrennt angegeben wurden
    if (args.widgetParameter.includes(';')) {
      const params = args.widgetParameter.split(';');
      studioNumbers = [];
      
      for (const param of params) {
        const studioNumber = parseInt(param.trim());
        if (!isNaN(studioNumber) && studioNumber > 0) {
          studioNumbers.push(studioNumber);
        }
      }
      
      // Wenn keine gültigen Studios gefunden wurden, Standardstudio verwenden
      if (studioNumbers.length === 0) {
        studioNumbers = [config.defaultStudioNumber];
      }
      
      // Maximal 3 Studios anzeigen
      if (studioNumbers.length > 3) {
        studioNumbers = studioNumbers.slice(0, 3);
      }
    } else {
      // Einzelnes Studio
      const studioNumber = parseInt(args.widgetParameter);
      if (!isNaN(studioNumber) && studioNumber > 0) {
        studioNumbers = [studioNumber];
      }
    }
  }
  
  return studioNumbers;
}

// Alte getStudioNumber-Funktion für Kompatibilität beibehalten
function getStudioNumber() {
  return getStudioNumbers()[0];
}

// Hilfsfunktionen
const FileHelper = {
  fm: FileManager.iCloud(),
  
  getFilePath(studioNumber, fileName) {
    return this.fm.joinPath(this.fm.documentsDirectory(), `wof${studioNumber}_${fileName}`);
  }
};

// Netzwerk-Funktionen
async function checkNetwork() {
    try {
        const request = new Request('https://www.apple.com/library/test/success.html');
        request.timeoutInterval = 5;
        const response = await request.loadString();
        return response.includes('Success');
    } catch (error) {
        console.log('Netzwerk nicht verfügbar:', error);
        return false;
    }
}

// Vereinfachte Benachrichtigungsfunktion
async function showNotification(title, message) {
  const notification = new Notification();
  notification.title = title;
  notification.body = message;
  await notification.schedule();
}

// Validierungsfunktionen für die Eingabedaten 
function validateInput(html, studioNumber) {
  if (!html || typeof html !== 'string') {
    throw new Error('Ungültige HTML-Daten');
  }
  
  if (!studioNumber || isNaN(studioNumber) || studioNumber <= 0) {
    throw new Error(`Ungültige Studio-Nummer: ${studioNumber}`);
  }
  
  // Prüfe auf gültiges HTML-Format
  if (!html.includes('<table') || !html.includes('</table>')) {
    throw new Error('Ungültiges HTML-Format: Keine Tabelle gefunden');
  }
  
  return true;
}

function validateBelegung(belegung, studioName) {
  if (isNaN(belegung)) {
    throw new Error(`Ungültiger Belegungswert für ${studioName}`);
  }
  
  if (belegung < 0 || belegung > 100) {
    throw new Error(`Belegungswert außerhalb des gültigen Bereichs (0-100%): ${belegung}%`);
  }
  
  return true;
}

function parseHTMLForStudio(html, studioNumber) {
  // Validiere Eingabedaten
  validateInput(html, studioNumber);
  
  const rowPattern = /<tr[\s\S]*?<\/tr>/g;
  const rows = html.match(rowPattern) || [];
  const availableStudios = [];
  
  for (const row of rows) {
    const cells = row.match(/<td[\s\S]*?<\/td>/g);
    if (!cells || cells.length < 2) continue;
    
    const studioName = cells[0].replace(/<[^>]+>/g, '').trim();
    const studioMatch = studioName.match(/WOF\s*(\d+)/i);
    
    if (studioMatch) {
      const foundStudioNumber = parseInt(studioMatch[1]);
      availableStudios.push(foundStudioNumber);
      
      if (foundStudioNumber === studioNumber) {
        const belegung = parseInt(cells[1].replace(/<[^>]+>|%/g, ''));
        
        // Validiere Belegungswert
        validateBelegung(belegung, studioName);
        
        return {
          name: studioName,
          belegung: belegung
        };
      }
    }
  }
  
  // Sortiere die Studios numerisch für bessere Lesbarkeit
  availableStudios.sort((a, b) => a - b);
  
  throw new Error(`WOF ${studioNumber} nicht gefunden!\nVerfügbare WOF-Studios: ${availableStudios.join(', ')}`);
}

// Cache-Management-Funktionen
async function updateCache(studioNumber, data) {
    try {
        const cacheEntry = {
            timestamp: new Date().toISOString(),
            data: data,
            lastUpdate: Date.now()
        };
        const cachePath = FileHelper.getFilePath(studioNumber, 'latest_cache.json');
        FileHelper.fm.writeString(cachePath, JSON.stringify(cacheEntry));
    } catch (error) {
        console.error('Fehler beim Cache-Update:', error);
    }
}

async function scheduleCacheUpdate(studioNumber) {
    if (await checkNetwork()) {
        try {
            const html = await new Request(CONSTANTS.URL).loadString();
            const wofData = parseHTMLForStudio(html, studioNumber);
            if (wofData) {
                await updateCache(studioNumber, wofData);
                return wofData; // Erfolgreiche Daten zurückgeben
            }
        } catch (error) {
            console.error('Fehler bei Cache-Aktualisierung:', error);
            throw error; // Fehler weiterleiten
        }
    }
    return null; // Keine Daten aktualisiert
}

// Cache-Funktionen
function getLatestCache(studioNumber) {
    const cachePath = FileHelper.getFilePath(studioNumber, 'latest_cache.json');
    if (FileHelper.fm.fileExists(cachePath)) {
        try {
            const cacheData = JSON.parse(FileHelper.fm.readString(cachePath));
            
            const cacheAge = (Date.now() - new Date(cacheData.timestamp).getTime()) / (1000 * 60);
            if (cacheAge > CONSTANTS.CACHE_MAX_AGE_MINUTES) {
                console.log(`Cache ist veraltet (${Math.round(cacheAge)} Minuten alt)`);
                return null;
            }
            
            return cacheData;
        } catch (e) {
            console.log('Fehler beim Laden des Caches:', e);
            return null;
        }
    }
    return null;
}

// Darstellungsfunktionen
function getColorForPercentage(percent) {
  if (percent === null) return Color.gray();
  return percent > 30 ? Color.red() :
         percent > 16 ? Color.orange() :
         Color.green();
}

// Widget-Erstellung
async function createWidget() {
    const widget = new ListWidget();
    widget.setPadding(12, 12, 12, 12);
    
    const studioNumbers = getStudioNumbers();
    
    // Header anpassen je nach Anzahl der Studios
    if (studioNumbers.length === 1) {
      // Für ein einzelnes Studio: Einzeiliger Header
      const headerStack = widget.addStack();
      headerStack.layoutHorizontally();
      
      const headerText = headerStack.addText(`🏋️ WOF ${studioNumbers[0]} Belegung`);
      headerText.font = Font.semiboldRoundedSystemFont(16);
      headerText.textColor = Color.dynamic(Color.black(), Color.white());
    } else {
      // Für mehrere Studios: Zweizeiliger Header
      const headerStack = widget.addStack();
      headerStack.layoutVertically();
      
      // Erste Zeile: Emoji und WOF
      const firstLineStack = headerStack.addStack();
      firstLineStack.layoutHorizontally();
      
      const headerText1 = firstLineStack.addText(`🏋️ WOF`);
      headerText1.font = Font.semiboldRoundedSystemFont(16);
      headerText1.textColor = Color.dynamic(Color.black(), Color.white());
      
      // Zweite Zeile: Belegung
      const secondLineStack = headerStack.addStack();
      secondLineStack.layoutHorizontally();
      
      const headerText2 = secondLineStack.addText(`Belegung`);
      headerText2.font = Font.semiboldRoundedSystemFont(16);
      headerText2.textColor = Color.dynamic(Color.black(), Color.white());
    }
    
    widget.addSpacer();
    
    // Cache-Update bei jedem Widget-Refresh für alle Studios durchführen
    try {
        // HTML-Daten nur einmal abrufen und für alle Studios wiederverwenden
        const networkAvailable = await checkNetwork();
        const html = networkAvailable ? await new Request(CONSTANTS.URL).loadString() : null;
        
        // Daten für alle Studios laden
        const studioData = [];
        let isOffline = false;
        
        for (const studioNumber of studioNumbers) {
            const cachedData = getLatestCache(studioNumber);
            let wofData;
            let studioOffline = false;
            
            if (networkAvailable) {
                try {
                    if (html) {
                        wofData = parseHTMLForStudio(html, studioNumber);
                    }
                    
                    if (wofData) {
                        // Sicherstellen, dass der Cache aktualisiert wird
                        await updateCache(studioNumber, wofData).catch(error => {
                            console.error(`Fehler beim Cache-Update für WOF ${studioNumber}:`, error);
                        });
                    }
                } catch (error) {
                    console.error(`Fehler beim Laden der Live-Daten für WOF ${studioNumber}:`, error);
                    if (cachedData) {
                        wofData = cachedData.data;
                        studioOffline = true;
                        isOffline = true;
                    } else {
                        throw new Error(`Keine Daten für WOF ${studioNumber} verfügbar`);
                    }
                }
            } else if (config.enableOfflineMode && cachedData) {
                wofData = cachedData.data;
                studioOffline = true;
                isOffline = true;
            } else {
                throw new Error('Keine Netzwerkverbindung und kein Cache verfügbar');
            }
            
            studioData.push({
                studioNumber,
                data: wofData,
                offline: studioOffline,
                cacheTimestamp: studioOffline ? cachedData.timestamp : null
            });
        }
        
        if (isOffline) {
            const offlineStack = widget.addStack();
            offlineStack.layoutHorizontally();
            
            const offlineText = offlineStack.addText('⚠️ Offline-Modus');
            offlineText.textColor = Color.orange();
            offlineText.font = Font.mediumRoundedSystemFont(12);
        }
        
        widget.addSpacer();
        
        // Belegungsdaten anzeigen
        if (studioNumbers.length === 1) {
            // Nur ein Studio: Zeige nur die Prozentzahl groß an
            const studio = studioData[0];
            const percentageStack = widget.addStack();
            percentageStack.layoutHorizontally();
            
            const belegungText = percentageStack.addText(`${studio.data.belegung}%`);
            belegungText.font = Font.boldRoundedSystemFont(36);
            belegungText.textColor = config.enableColorCoding ? 
                getColorForPercentage(studio.data.belegung) : 
                Color.dynamic(Color.black(), Color.white());
        } else {
            // Mehrere Studios: Zeige Studio-Namen und Prozentzahlen an
            for (const studio of studioData) {
                const studioStack = widget.addStack();
                studioStack.layoutHorizontally();
                
                // Studio-Name
                const studioNameText = studioStack.addText(`WOF ${studio.studioNumber}: `);
                studioNameText.font = Font.mediumRoundedSystemFont(14);
                studioNameText.textColor = Color.dynamic(Color.black(), Color.white());
                
                // Belegung
                const belegungText = studioStack.addText(`${studio.data.belegung}%`);
                belegungText.font = Font.boldRoundedSystemFont(14);
                belegungText.textColor = config.enableColorCoding ? 
                    getColorForPercentage(studio.data.belegung) : 
                    Color.dynamic(Color.black(), Color.white());
                
                // Abstand zwischen den Studios
                if (studioData.indexOf(studio) < studioData.length - 1) {
                    widget.addSpacer(4);
                }
            }
        }
        
        widget.addSpacer();
        
        if (config.enableTimestamp) {
            const timestamp = widget.addText(`Stand: ${new Date().toLocaleTimeString()}`);
            timestamp.font = Font.mediumRoundedSystemFont(12);
            timestamp.textColor = Color.gray();
        }
        
    } catch (error) {
        console.error(error);
        const errorText = widget.addText(`⚠️ ${error.message.split('\n')[0]}`);
        errorText.textColor = Color.red();
    }
    
    widget.refreshAfterDate = new Date(Date.now() + CONSTANTS.UPDATE_INTERVAL_MINUTES * 60 * 1000);
    
    return widget;
}

// Script-Ausführung
async function runWidget() {
    const widget = await createWidget();
    if (config.runsInWidget) {
        Script.setWidget(widget);
    } else {
        await widget.presentMedium();
    }
    Script.complete();
}

// Hauptausführung
(async () => {
    await runWidget();
})();

async function cleanupCache() {
    const maxAgeMs = CONSTANTS.MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000;
    // Implementierung der Cache-Bereinigung basierend auf dem Alter
}
