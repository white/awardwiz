// ITA has multiple methods to mess with scraping such that search results will be arbitrarily
// delayed and only give 10 direct flights. Things that trigger this protection:
//   - Existance of navigator.webdriver
//   - Having notifications disabled in the webbrowser
//   - Spending a very short amount of time on the search screen

/**
 * @param {import("puppeteer").Page} page
 * @param {SearchQuery} input
 */
exports.scraperMain = async(page, input) => {
  console.log("Going to homepage...")
  await page.goto("https://matrix.itasoftware.com")

  console.log("Setting one way...")
  const tabs = await page.$$(".gwt-TabBarItem .gwt-HTML")
  await tabs[1].click()

  console.log("Setting origin...")
  const fields = await page.$$(".gwt-SuggestBox")
  await fields[2].focus()
  await page.keyboard.type(input.origin)
  const originXPath = `//span[contains(text(), '(${input.origin})')]`
  await page.waitForXPath(originXPath, {timeout: 0})
  await page.evaluate(`document.evaluate("${originXPath}", document).iterateNext().click()`)

  console.log("Setting destination...")
  await fields[3].focus()
  await page.keyboard.type(input.destination)
  const destinationXPath = `//span[contains(text(), '(${input.destination})')]`
  await page.waitForXPath(destinationXPath, {timeout: 0})
  await page.evaluate(`document.evaluate("${destinationXPath}", document).iterateNext().click()`)

  console.log("Setting no connections...")
  const [stopsElement] = (await page.$x("//label[contains(text(), 'Stops')]/..//select"))
  stopsElement.focus()
  stopsElement.press("N")
  stopsElement.press("Enter")

  console.log("Setting currency...")
  const [currencyElement] = await page.$x("//label[text()=' Currency ']/../div[1]/input[1]")
  await currencyElement.focus()
  await page.keyboard.type("USD")
  const currencySuggestXPath = "//td[contains(text(), '(USD)')]"
  await page.waitForXPath(currencySuggestXPath, {timeout: 0})
  await page.evaluate(`document.evaluate("${currencySuggestXPath}", document).iterateNext().click()`)

  console.log("Setting date...")
  await (await page.$x("(//div[contains(text(), 'Departure Date')]/..)[1]/div[2]/input"))[0].focus()
  await page.keyboard.type(`${input.date.substr(5, 2)}/${input.date.substr(8, 2)}/${input.date.substr(0, 4)}`)    // mm/dd/year
  await tabs[1].click()     // hide calendar

  console.log("Waiting 5 seconds to make sure ITA doesnt flag us as a bot...")
  await page.waitFor(5000)

  console.log("Starting search...")
  await Promise.all([
    page.click("button"),
    page.waitForResponse("https://matrix.itasoftware.com/search", {timeout: 0}),
    page.waitForResponse("https://matrix.itasoftware.com/pricecurve", {timeout: 0})
  ])

  // We use time-bars mode because it gives us more info about the flights
  console.log("Switching to time-bars mode")
  await page.click("a[title='View color time bars'] span")
  await page.waitForResponse("https://matrix.itasoftware.com/search", {timeout: 0})
  await page.waitFor(100)

  // If there are multiple pages, request everything
  const allLink = await page.$x("//a[text()='All']")
  if (allLink.length > 0) {
    console.log("Loading the 'All' page...")
    await Promise.all([
      allLink[0].click(),
      page.waitForXPath("//span[text()='All']", {timeout: 0})
    ])
  }

  // Unfortunately the AJAX request is all messed up, so we'll need to scrape the UI
  console.log("Hovering all flights for details and parsing...")

  /** @type {SearchResult[]} */
  const results = []
  /** @type {string[]} */
  const warnings = []

  // With this time-bar UI, the first step is to hover over all bars to get the flight
  // details added to the dom.
  const allResults = await page.$x("//span[text()='From']/../../..")
  for (const rowElement of allResults) {
    // Remove focus from the current mouse-hover details view
    await page.hover(".logo")
    await page.waitFor(200)

    const [barElement] = await rowElement.$x(".//div[3]/div[1]/div[1]/div[1]")
    await barElement.hover()

    const [detailsElement] = await page.$x("(//div[@class='popupContent']/div[1]/div[contains(text(), ' flight ')]/..)[last()]")

    let result = null
    try {
      result = await getFlightFromRow(page, input, rowElement, detailsElement)
    } catch (err) {
      warnings.push(err.message)
    }

    if (result)
      results.push(result)
  }

  // Kind of a hack, but sometimes when flights are really short, ITA doesn't return the airline
  // code since it can't fit in their little bar graphic. Here we try to guess the code based on
  // other results. The better way to do this would be to just have a lookup table that's hardcoded...
  for (const result of results) {
    if (result.flightNo && result.flightNo.startsWith("??")) {
      for (const check of results) {
        if (check.flightNo && !check.flightNo.startsWith("??") && result.airline === check.airline) {
          result.flightNo = `${check.flightNo.substr(0, 2)}${result.flightNo.substr(2)}`
          break
        }
      }
    }
  }

  console.log("Done.")
  return {searchResults: results, warnings}
}

/** after you've already hovered over the bar, retrieve the details from the flight
 * @param {import("puppeteer").Page} page
 * @param {SearchQuery} input
 * @param {import("puppeteer").ElementHandle<Element>} rowElement
 * @param {import("puppeteer").ElementHandle<Element>} detailsElement
 * @returns {Promise<SearchResult | null>}
 */
const getFlightFromRow = async(page, input, rowElement, detailsElement) => {
  /** @type {SearchResult} */
  const result = {
    departureDateTime: "",
    arrivalDateTime: "",
    origin: (await xPathInnerText(page, ".//div[2]", rowElement, "origin/destination of flight")).split(" to ")[0],
    destination: (await xPathInnerText(page, ".//div[2]", rowElement, "origin/destination of flight")).split(" to ")[1],
    duration: await xPathInnerText(page, ".//table[2]/tbody[1]/tr[1]/td[2]/div[1]", detailsElement, "flight duration"),
    aircraft: await xPathInnerText(page, ".//table[2]/tbody[1]/tr[3]/td[2]/div[1]", detailsElement, "aircraft type used for flight"),
    airline: (await xPathInnerText(page, ".//div[1]", detailsElement, "airline name and flight number")).split(" flight ")[0],
    flightNo: null,
    costs: {
      economy: {miles: null, cash: parseInt((await xPathInnerText(page, ".//div[1]/button[1]/span[2]", rowElement, "economy cash amount")).replace("$", ""), 10)},
      business: {miles: null, cash: null},
      first: {miles: null, cash: null}
    }
  }

  let airlineCode = null
  try {
    airlineCode = await xPathInnerText(page, ".//div[3]/div[1]/div[1]/div[1]/div[1]/div[1]", rowElement, "2-letter airline code")
    // Skip codeshares since the proper flights should be on the list anyways
    if (airlineCode.endsWith("*"))
      return null
  } catch (err) {
    airlineCode = "??"
  }

  const [, flightNumber] = (await xPathInnerText(page, ".//div[1]", detailsElement, "airline name and flight number")).split(" flight ")
  result.flightNo = `${airlineCode} ${flightNumber}`

  const departureTime24 = convert12HourTo24Hour(await xPathInnerText(page, ".//table[1]/tbody[1]/tr[1]/td[4]/div[1]", detailsElement, "departure time"))
  const departureDateStr = await xPathInnerText(page, ".//table[1]/tbody[1]/tr[1]/td[3]/div[1]", detailsElement, "departure date")
  result.departureDateTime = `${input.date} ${departureTime24}`

  const arrivalTime24 = convert12HourTo24Hour(await xPathInnerText(page, ".//table[1]/tbody[1]/tr[2]/td[4]/div[1]", detailsElement, "arrival time"))
  const arrivalDateStr = await xPathInnerText(page, ".//table[1]/tbody[1]/tr[2]/td[3]/div[1]", detailsElement, "arrival date")

  const [departureMonthName] = departureDateStr.split(" ")
  const [arrivalMonthName, arrivalDay] = arrivalDateStr.split(" ")

  // Handle the year-change edge-case
  let arrivalYear = parseInt(input.date.substr(0, 4), 10)  // Start it at the search year
  if (departureMonthName === "Dec" && arrivalMonthName === "Jan") {
    arrivalYear += 1
  } else if (departureMonthName === "Jan" && arrivalMonthName === "Dec") {
    arrivalYear -= 1
  }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  result.arrivalDateTime = `${arrivalYear.toString()}-${(months.indexOf(arrivalMonthName) + 1).toString().padStart(2, "0")}-${arrivalDay.padStart(2, "0")} ${arrivalTime24}`

  return result
}

/** Takes a 12-hour (1 or 2 digit hour) time, and converts it to 24-hour (2 digit hour)
 * @param {string} twelveHour
 * @returns {string} */
const convert12HourTo24Hour = twelveHour => {
  const [rawHour, rawMinute] = twelveHour.split(":")
  const [hour, minute] = [parseInt(rawHour, 10), parseInt(rawMinute.substr(0, 2), 10)]
  if (twelveHour.toUpperCase().indexOf("AM") >= 0)
    return `${(hour === 12 ? 0 : hour).toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`
  return `${(hour === 12 ? 12 : hour + 12).toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`
}

/** Returns the innerText of an XPath query on a page/element
 * @param {import("puppeteer").Page} page
 * @param {string} xPath
 * @param {import("puppeteer").ElementHandle | null} contextElement
 * @param {string} description when XPath isn't found, throw this description
 * @returns {Promise<string>} */
const xPathInnerText = async(page, xPath, contextElement, description) => {
  if (contextElement && !xPath.startsWith("."))
    throw new Error("When using a context XPath element, the path must start with a '.'")
  const [foundElement] = (await (contextElement || page).$x(xPath))
  if (!foundElement)
    throw new Error(`Unable to find XPath "${xPath}": ${description}`)
  return page.evaluate(pageEl => pageEl.innerText, foundElement)
}
