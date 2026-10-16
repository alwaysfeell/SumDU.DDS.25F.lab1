import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const CITIES = [
  'Paris', 'London', 'Tokyo', 'New York', 'Rome',
  'Barcelona', 'Amsterdam', 'Berlin', 'Prague', 'Vienna'
];

const LOCATIONS = [
  'Eiffel Tower', 'Big Ben', 'Colosseum', 'Sagrada Familia',
  'Brandenburg Gate', 'Anne Frank House', 'Tokyo Tower',
  'Statue of Liberty', 'Golden Gate Bridge', 'Sydney Opera House'
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF'];

const ADJECTIVES = [
  'Amazing', 'Beautiful', 'Exciting', 'Wonderful', 'Fantastic',
  'Memorable', 'Epic', 'Incredible', 'Unforgettable', 'Perfect'
];

export function generateFutureDate(daysFromNow = 30) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().split('T')[0];
}

export function generateTravelPlan() {
  const adjective = randomItem(ADJECTIVES);
  const city = randomItem(CITIES);
  const startDays = randomIntBetween(10, 60);
  const duration = randomIntBetween(3, 21);

  return {
    title: `${adjective} ${city} Trip`,
    description: `A ${duration}-day adventure in ${city}`,
    start_date: generateFutureDate(startDays),
    end_date: generateFutureDate(startDays + duration),
    budget: parseFloat((Math.random() * 5000 + 500).toFixed(2)),
    currency: randomItem(CURRENCIES),
    is_public: Math.random() > 0.5,
  };
}

export function generateLocation() {
  const location = randomItem(LOCATIONS);
  const city = randomItem(CITIES);

  const latitude = parseFloat((Math.random() * 180 - 90).toFixed(6));
  const longitude = parseFloat((Math.random() * 360 - 180).toFixed(6));

  return {
    name: `${location}, ${city}`,
    address: `${randomIntBetween(1, 999)} Main Street, ${city}`,
    latitude: latitude,
    longitude: longitude,
    budget: parseFloat((Math.random() * 500 + 10).toFixed(2)),
    notes: `Must-see attraction in ${city}`,
  };
}

export function generateLocationWithDates(daysFromNow = 30) {
  const location = generateLocation();
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + daysFromNow);

  const arrivalHour = randomIntBetween(8, 14);
  const stayDuration = randomIntBetween(2, 8);

  const arrival = new Date(baseDate);
  arrival.setHours(arrivalHour, 0, 0, 0);

  const departure = new Date(arrival);
  departure.setHours(arrivalHour + stayDuration, 0, 0, 0);

  return {
    ...location,
    arrival_date: arrival.toISOString(),
    departure_date: departure.toISOString(),
  };
}

export function generateTravelPlanUpdate(currentVersion) {
  const plan = generateTravelPlan();
  return {
    ...plan,
    title: `Updated: ${plan.title}`,
    version: currentVersion,
  };
}

export function generateInvalidData(invalidationType) {
  const base = generateTravelPlan();

  switch (invalidationType) {
    case 'missing_title':
      delete base.title;
      return base;

    case 'empty_title':
      return { ...base, title: '   ' };

    case 'long_title':
      return { ...base, title: 'A'.repeat(250) };

    case 'invalid_dates':
      return {
        ...base,
        start_date: generateFutureDate(50),
        end_date: generateFutureDate(30),
      };

    case 'negative_budget':
      return { ...base, budget: -100.50 };

    case 'invalid_currency':
      return { ...base, currency: 'INVALID' };

    case 'invalid_coordinates':
      const loc = generateLocation();
      return { ...loc, latitude: 95.0 };

    default:
      return base;
  }
}

export function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function generateMultipleLocations(count = 3) {
  const locations = [];
  for (let i = 0; i < count; i++) {
    locations.push(generateLocationWithDates(30 + i));
  }
  return locations;
}
